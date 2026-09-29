import { authHeaders } from './credentials.ts';
import { ProviderError } from './errors.ts';
import { getJson, joinUrl, openStream, parseToolArguments } from './http.ts';
import { readSse } from './sse.ts';
import type { ChatMessage, ChatRequest, ContentBlock, ListedModel, ListModelsRequest, ProviderAdapter, StreamEvent } from './types.ts';

/** OpenAI Chat Completions protocol — used for OpenAI-compatible servers (ALCF, vLLM, Ollama, LM Studio, proxies). */

function userContent(blocks: ContentBlock[]): unknown {
  if (blocks.every((b) => b.type === 'text')) return blocks.map((b) => (b as { text: string }).text).join('\n\n');
  return blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.dataBase64}` } };
    return { type: 'file', file: { filename: b.filename, file_data: `data:application/pdf;base64,${b.dataBase64}` } };
  });
}

export function toChatCompletionsMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.content) });
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      out.push({ role: 'assistant', content: m.text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content || '(no output)' });
    }
  }
  return out;
}

interface ChatChunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

export const openAiChatAdapter: ProviderAdapter = {
  protocol: 'openai_chat',

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const { connection, model } = req;
    const body: Record<string, unknown> = {
      model: model.apiModelId,
      messages: toChatCompletionsMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxOutputTokens,
    };
    if (model.params.temperature !== undefined) body.temperature = model.params.temperature;
    if (model.params.reasoningEffort) body.reasoning_effort = model.params.reasoningEffort;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const requestOptions = {
      url: joinUrl(connection.baseUrl, 'chat/completions'),
      headers: { ...connection.extraHeaders, ...authHeaders(connection.protocol, connection.authType, req.credential) },
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType, modelId: model.apiModelId },
      headersTimeoutMs: connection.accessType === 'institutional' ? 600_000 : 120_000,
    };

    let response: Response;
    try {
      response = await openStream({ ...requestOptions, body });
    } catch (err) {
      // Some compatible servers reject stream_options; retry the same request once without it.
      if (err instanceof ProviderError && err.kind === 'bad_request' && /stream_options|include_usage/i.test(err.message)) {
        delete body.stream_options;
        response = await openStream({ ...requestOptions, body });
      } else {
        throw err;
      }
    }

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: ChatChunk['usage'] = null;
    for await (const message of readSse(response.body, { signal: req.signal, providerName: connection.name })) {
      if (message.data === '[DONE]') break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(message.data) as ChatChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError('server', `${connection.name} reported an error: ${chunk.error.message ?? 'unknown error'}`);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) yield { type: 'text', text: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const current = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name && !current.name) current.name = tc.function.name;
        if (tc.function?.arguments) current.args += tc.function.arguments;
        calls.set(index, current);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (usage) yield { type: 'usage', inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null };
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, call] of ordered) {
      if (!call.name) continue;
      yield { type: 'tool_call', call: { id: call.id || `call_${index}`, name: call.name, input: parseToolArguments(call.args) } };
    }
    yield {
      type: 'done',
      stopReason: ordered.some(([, c]) => c.name) ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end',
    };
  },

  async listModels(req: ListModelsRequest): Promise<ListedModel[]> {
    const { connection } = req;
    const json = await getJson<{ data?: { id: string; max_model_len?: number; context_length?: number }[] }>({
      url: joinUrl(connection.baseUrl, 'models'),
      headers: { ...connection.extraHeaders, ...authHeaders(connection.protocol, connection.authType, req.credential) },
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType },
      headersTimeoutMs: 30_000,
    });
    if (!Array.isArray(json.data)) throw new ProviderError('bad_response', `${connection.name} didn't return a model list.`);
    return json.data
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ apiModelId: m.id, displayName: m.id, contextWindow: m.max_model_len ?? m.context_length }));
  },
};
