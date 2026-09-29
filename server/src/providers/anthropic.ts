import { authHeaders } from './credentials.ts';
import { ProviderError } from './errors.ts';
import { getJson, joinUrl, openStream, parseToolArguments } from './http.ts';
import { readSse } from './sse.ts';
import type { ChatMessage, ChatRequest, ContentBlock, ListedModel, ListModelsRequest, ProviderAdapter, StreamEvent } from './types.ts';

/** Anthropic Messages API. */

const ANTHROPIC_VERSION = '2023-06-01';

type Block = Record<string, unknown> & { type: string };

function userBlock(block: ContentBlock): Block {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.dataBase64 } };
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: block.dataBase64 }, title: block.filename };
}

export function toAnthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: Block[] }[] {
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const clean = blocks.filter((b) => !(b.type === 'text' && !(b.text as string)));
    if (clean.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...clean);
    else out.push({ role, content: clean });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', m.content.map(userBlock));
    } else if (m.role === 'assistant') {
      const state = m.providerState?.protocol === 'anthropic_messages' ? (m.providerState.data as { blocks?: Block[] }) : null;
      if (state?.blocks?.length) push('assistant', state.blocks);
      else {
        push('assistant', [
          { type: 'text', text: m.text },
          ...(m.toolCalls ?? []).map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })),
        ]);
      }
    } else {
      push(
        'user',
        m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content || '(no output)', is_error: r.isError })),
      );
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing the conversation)' }] });
  return out;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  content_block?: Block;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

export const anthropicAdapter: ProviderAdapter = {
  protocol: 'anthropic_messages',

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const { connection, model } = req;
    const body: Record<string, unknown> = {
      model: model.apiModelId,
      max_tokens: req.maxOutputTokens,
      messages: toAnthropicMessages(req.messages),
      stream: true,
    };
    if (req.system) body.system = req.system;
    if (model.params.temperature !== undefined) body.temperature = model.params.temperature;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const response = await openStream({
      url: joinUrl(connection.baseUrl, 'messages'),
      headers: {
        ...connection.extraHeaders,
        'anthropic-version': ANTHROPIC_VERSION,
        ...authHeaders(connection.protocol, connection.authType, req.credential),
      },
      body,
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType, modelId: model.apiModelId },
    });

    const blocks: (Block & { _json?: string })[] = [];
    let stop = 'end_turn';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for await (const message of readSse(response.body, { signal: req.signal, providerName: connection.name })) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(message.data) as AnthropicEvent;
      } catch {
        continue;
      }
      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage;
          if (u) inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          break;
        }
        case 'content_block_start': {
          const b = event.content_block;
          if (!b || event.index === undefined) break;
          if (b.type === 'tool_use') blocks[event.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' };
          else if (b.type === 'text') {
            blocks[event.index] = { type: 'text', text: (b.text as string) ?? '' };
            if (b.text) yield { type: 'text', text: b.text as string };
          } else blocks[event.index] = { ...b };
          break;
        }
        case 'content_block_delta': {
          const b = event.index !== undefined ? blocks[event.index] : undefined;
          const d = event.delta;
          if (!b || !d) break;
          if (d.type === 'text_delta' && d.text) {
            b.text = `${(b.text as string) ?? ''}${d.text}`;
            yield { type: 'text', text: d.text };
          } else if (d.type === 'input_json_delta') b._json = `${b._json ?? ''}${d.partial_json ?? ''}`;
          else if (d.type === 'thinking_delta') b.thinking = `${(b.thinking as string) ?? ''}${d.thinking ?? ''}`;
          else if (d.type === 'signature_delta') b.signature = `${(b.signature as string) ?? ''}${d.signature ?? ''}`;
          break;
        }
        case 'content_block_stop': {
          const b = event.index !== undefined ? blocks[event.index] : undefined;
          if (b?.type === 'tool_use') {
            b.input = parseToolArguments(b._json ?? '');
            delete b._json;
            yield { type: 'tool_call', call: { id: String(b.id), name: String(b.name), input: b.input as Record<string, unknown> } };
          }
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stop = event.delta.stop_reason;
          if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError(
            event.error?.type === 'overloaded_error' ? 'overloaded' : event.error?.type === 'rate_limit_error' ? 'rate_limit' : 'server',
            `${connection.name} reported an error: ${event.error?.message ?? 'unknown error'}`,
          );
        default:
          break;
      }
    }
    yield { type: 'usage', inputTokens, outputTokens };
    const finalBlocks = blocks.filter(Boolean).map(({ _json, ...b }) => b as Block);
    yield {
      type: 'done',
      stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : 'other',
      providerState: { protocol: 'anthropic_messages', data: { blocks: finalBlocks } },
    };
  },

  async listModels(req: ListModelsRequest): Promise<ListedModel[]> {
    const { connection } = req;
    const json = await getJson<{ data?: { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }[] }>({
      url: `${joinUrl(connection.baseUrl, 'models')}?limit=1000`,
      headers: {
        ...connection.extraHeaders,
        'anthropic-version': ANTHROPIC_VERSION,
        ...authHeaders(connection.protocol, connection.authType, req.credential),
      },
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType },
      headersTimeoutMs: 30_000,
    });
    if (!Array.isArray(json.data)) throw new ProviderError('bad_response', `${connection.name} didn't return a model list.`);
    return json.data.map((m) => ({
      apiModelId: m.id,
      displayName: m.display_name ?? m.id,
      contextWindow: m.max_input_tokens,
      maxOutputTokens: m.max_tokens,
    }));
  },
};
