import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelDto } from '../../shared/types.ts';
import { ModelRunner } from '../src/chat/model-runner.ts';
import { anthropicAdapter } from '../src/providers/anthropic.ts';
import { CredentialResolver } from '../src/providers/credentials.ts';
import { errorFromHttp, ProviderError } from '../src/providers/errors.ts';
import { geminiAdapter, toGeminiContents } from '../src/providers/gemini.ts';
import { openAiChatAdapter } from '../src/providers/openai-chat.ts';
import { openAiResponsesAdapter, toResponsesInput } from '../src/providers/openai-responses.ts';
import { readSse } from '../src/providers/sse.ts';
import type { ChatRequest, ConnectionRecord, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { MemorySecretStore } from '../src/secrets/secret-store.ts';
import { addModel, chatRequests, createTestEnv } from './helpers.ts';
import { scriptedChat, sse } from './fixtures/mock-provider.ts';

const model: ModelDto = {
  id: 'm',
  connectionId: 'c',
  apiModelId: 'test-model',
  displayName: 'Test',
  contextWindow: 32000,
  maxOutputTokens: 1000,
  supportsStreaming: true,
  supportsTools: true,
  supportsImages: true,
  supportsPdfs: true,
  params: {},
  enabled: true,
  sortOrder: 0,
};

function connection(protocol: ConnectionRecord['protocol'], authType: ConnectionRecord['authType'] = 'api_key'): ConnectionRecord {
  return { id: 'c', name: 'Provider', preset: 'custom', protocol, accessType: 'paid_api', baseUrl: 'https://api.example.test/v1', authType, tokenCommand: null, extraHeaders: {}, status: 'verified' };
}

async function run(adapter: ProviderAdapter, respond: (url: string, body: any, headers: Headers) => Response, overrides: Partial<ChatRequest> = {}) {
  const seen: { url: string; body: any; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), body, headers });
    return respond(String(input), body, headers);
  };
  const events: StreamEvent[] = [];
  for await (const e of adapter.stream({
    connection: connection(adapter.protocol),
    model,
    credential: 'secret-key',
    system: 'Be helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
    maxOutputTokens: 500,
    signal: new AbortController().signal,
    fetchImpl,
    ...overrides,
  })) {
    events.push(e);
  }
  return { events, seen, text: events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('') };
}

describe('provider adapters', () => {
  test('OpenAI-compatible Chat Completions: streams text, assembles tool calls, reports usage', async () => {
    const { events, seen, text } = await run(openAiChatAdapter, () =>
      sse([
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'world' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"que' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"tones"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
        'data: [DONE]\n\n',
      ]),
    );
    assert.equal(text, 'Hello world');
    assert.equal(seen[0]!.url, 'https://api.example.test/v1/chat/completions');
    assert.equal(seen[0]!.headers.get('authorization'), 'Bearer secret-key');
    assert.equal(seen[0]!.body.messages[0].role, 'system');
    const call = events.find((e) => e.type === 'tool_call');
    assert.deepEqual(call && call.type === 'tool_call' && call.call.input, { query: 'tones' });
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 11, outputTokens: 7 });
    assert.equal(events.at(-1)?.type === 'done' && events.at(-1)?.type === 'done' ? (events.at(-1) as { stopReason: string }).stopReason : '', 'tool_use');
  });

  test('Anthropic Messages: text and tool_use deltas, headers, and replayable content blocks', async () => {
    const { events, seen, text } = await run(anthropicAdapter, () =>
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'search.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Augustine sermons"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]),
    );
    assert.equal(text, 'Let me search.');
    assert.equal(seen[0]!.url, 'https://api.example.test/v1/messages');
    assert.equal(seen[0]!.headers.get('x-api-key'), 'secret-key');
    assert.equal(seen[0]!.headers.get('anthropic-version'), '2023-06-01');
    assert.equal(seen[0]!.body.system, 'Be helpful.');
    assert.equal(seen[0]!.body.tools[0].input_schema.type, 'object');
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.stopReason, 'tool_use');
    const blocks = (done.providerState!.data as { blocks: { type: string; input?: unknown }[] }).blocks;
    assert.deepEqual(blocks[1], { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'Augustine sermons' } });
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 50, outputTokens: 12 });
  });

  test('Gemini generateContent: streams parts and replays thought signatures exactly', async () => {
    const { events, seen, text } = await run(geminiAdapter, () =>
      sse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'check.', thoughtSignature: 'sig-text' }] } }] },
        {
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'web_search', args: { query: 'x' } }, thoughtSignature: 'sig-call' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ]),
    );
    assert.equal(text, 'Let me check.');
    assert.equal(seen[0]!.url, 'https://api.example.test/v1/models/test-model:streamGenerateContent?alt=sse');
    assert.equal(seen[0]!.headers.get('x-goog-api-key'), 'secret-key');
    assert.equal(seen[0]!.body.systemInstruction.parts[0].text, 'Be helpful.');
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const replay = toGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', text: 'Let me check.', toolCalls: [], providerState: done.providerState },
      { role: 'tool', results: [{ toolCallId: 'gemini_call_0', name: 'web_search', content: 'results', isError: false }] },
    ]);
    const modelParts = replay[1]!.parts;
    assert.deepEqual(modelParts.map((p) => p.thoughtSignature ?? null), [null, 'sig-text', 'sig-call']);
    assert.deepEqual(replay[2]!.parts[0], { functionResponse: { name: 'web_search', response: { result: 'results' } } });
  });

  test('OpenAI Responses: store=false, instructions, function calls, and stateless replay', async () => {
    const { events, seen, text } = await run(openAiResponsesAdapter, () =>
      sse([
        { type: 'response.output_text.delta', delta: 'Hi' },
        { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'web_search', arguments: '{"query":"q"}', status: 'completed' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } } },
      ]),
    );
    assert.equal(text, 'Hi');
    assert.equal(seen[0]!.body.store, false);
    assert.equal(seen[0]!.body.instructions, 'Be helpful.');
    assert.equal(seen[0]!.body.tools[0].name, 'web_search');
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const input = toResponsesInput([{ role: 'assistant', text: 'Hi', providerState: done.providerState }]) as Record<string, unknown>[];
    assert.ok(input.every((item) => !('id' in item) && !('status' in item)), 'server-side ids are stripped for stateless replay');
    assert.equal(input[1]!.call_id, 'call_9');
  });

  test('HTTP errors map to specific, actionable kinds', () => {
    const ctx = { connectionName: 'Provider', authType: 'api_key' as const, modelId: 'x' };
    assert.equal(errorFromHttp(401, '{"error":{"message":"bad key"}}', ctx).kind, 'auth');
    assert.equal(errorFromHttp(401, '', { ...ctx, authType: 'token_command' }).kind, 'expired');
    assert.equal(errorFromHttp(429, '{"error":{"message":"You exceeded your current quota"}}', ctx).kind, 'quota');
    assert.equal(errorFromHttp(429, '{"error":{"message":"slow down"}}', ctx).kind, 'rate_limit');
    assert.equal(errorFromHttp(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', ctx).kind, 'context_length');
    assert.equal(errorFromHttp(404, '', ctx).kind, 'model_not_found');
    assert.equal(errorFromHttp(529, '', ctx).retryable, true);
    assert.doesNotMatch(errorFromHttp(401, '{"error":{"message":"bad key"}}', ctx).message, /secret-key/);
  });

  test('SSE parsing survives CRLF line endings and arbitrary chunk boundaries', async () => {
    const raw = 'event: x\r\ndata: {"a":1}\r\n\r\n: comment\r\ndata: line1\r\ndata: line2\r\n\r\ndata: tail';
    const bytes = new TextEncoder().encode(raw);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const messages = [];
    for await (const m of readSse(stream, { signal: new AbortController().signal, providerName: 'test' })) messages.push(m);
    assert.deepEqual(messages, [
      { event: 'x', data: '{"a":1}' },
      { event: null, data: 'line1\nline2' },
      { event: null, data: 'tail' },
    ]);
  });
});

describe('credentials and provider selection', () => {
  test('missing credentials fail clearly and keep the user message', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const connection = await ctx.connections.create({ name: 'OpenAI API', protocol: 'openai_responses', accessType: 'paid_api', baseUrl: 'https://api.openai.com/v1', authType: 'api_key' });
      assert.equal(connection.status, 'needs_credentials');
      const m = ctx.models.create(connection.id, { apiModelId: 'some-model' });
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: m.id });
      await ctx.generation.send({ conversationId: chat.id, text: 'Keep this message safe', attachmentIds: [] });
      await ctx.generation.idle();
      const [user, reply] = ctx.conversations.listMessages(chat.id);
      assert.equal(user!.content, 'Keep this message safe');
      assert.equal(reply!.status, 'error');
      assert.equal(reply!.error?.code, 'credential_missing');
      assert.equal(reply!.error?.action, 'reconnect');
      assert.equal(env.requests.length, 0, 'nothing was sent anywhere');
    } finally {
      await env.cleanup();
    }
  });

  test('an expired token from a token command is refreshed once, then the request succeeds', async () => {
    const secrets = new MemorySecretStore();
    const tokens = ['expired-token-aaaaaaaa', 'fresh-token-bbbbbbbbbb'];
    let runs = 0;
    const resolver = new CredentialResolver(secrets, async () => tokens[Math.min(runs++, 1)]!);
    const conn: ConnectionRecord = { ...connection('openai_chat', 'token_command'), preset: 'alcf', tokenCommand: ['python3', 'inference_auth_token.py', 'get_access_token'] };
    const auths: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      auths.push(auth);
      if (auth.includes('expired')) return new Response('{"error":{"message":"token expired"}}', { status: 401 });
      return sse([{ choices: [{ delta: { content: 'ok' } }] }, 'data: [DONE]\n\n'], { signal: init?.signal });
    };
    const fakeConnections = { record: () => conn, noteRequestFailure: () => undefined } as never;
    const fakeModels = { find: () => model } as never;
    const runner = new ModelRunner({ connections: fakeConnections, models: fakeModels, credentials: resolver, fetchImpl });
    let text = '';
    for await (const e of runner.stream({ resolved: { model, connection: conn }, system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxOutputTokens: 10, signal: new AbortController().signal })) {
      if (e.type === 'text') text += e.text;
    }
    assert.equal(text, 'ok');
    assert.equal(runs, 2);
    assert.deepEqual(auths, ['Bearer expired-token-aaaaaaaa', 'Bearer fresh-token-bbbbbbbbbb']);
  });

  test('a failing provider is never silently replaced by another configured provider', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const a = await addModel(ctx, { connectionName: 'Provider A', baseUrl: 'http://127.0.0.1:59998/v1' });
      await addModel(ctx, { connectionName: 'Provider B', baseUrl: 'http://127.0.0.1:59997/v1', apiModelId: 'b-model' });
      env.setFetch(async () => new Response('{"error":{"message":"down"}}', { status: 503 }));
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: a.model.id });
      await ctx.generation.send({ conversationId: chat.id, text: 'hello', attachmentIds: [] });
      await ctx.generation.idle();
      const reply = ctx.conversations.listMessages(chat.id).at(-1)!;
      assert.equal(reply.status, 'error');
      assert.equal(reply.error?.code, 'overloaded');
      assert.ok(env.requests.length > 0);
      assert.ok(env.requests.every((r) => r.url.startsWith('http://127.0.0.1:59998/')), 'only the selected provider was contacted');
    } finally {
      await env.cleanup();
    }
  });

  test('connection test lists models without spending tokens and marks the connection verified', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { connection: conn } = await addModel(ctx);
      env.setFetch(scriptedChat([]).handler);
      const result = await ctx.connections.test(conn.id);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'verified');
      assert.deepEqual(result.models.map((m) => [m.apiModelId, m.alreadyAdded]), [['mock-model', true], ['other-model', false]]);
      assert.equal(chatRequests(env).length, 0);
    } finally {
      await env.cleanup();
    }
  });

  test('connection validation refuses plain http for remote hosts and credentials in extra headers', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      await assert.rejects(ctx.connections.create({ name: 'x', protocol: 'openai_chat', accessType: 'other', baseUrl: 'http://example.com/v1', authType: 'bearer_token' }), /https/);
      await assert.rejects(
        ctx.connections.create({ name: 'x', protocol: 'openai_chat', accessType: 'other', baseUrl: 'https://example.com/v1', authType: 'none', extraHeaders: { Authorization: 'Bearer abc' } }),
        /credential store/,
      );
      assert.ok(new ProviderError('network', 'x').retryable);
    } finally {
      await env.cleanup();
    }
  });
});
