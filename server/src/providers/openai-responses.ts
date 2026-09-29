import { authHeaders } from './credentials.ts';
import { ProviderError } from './errors.ts';
import { joinUrl, openStream, parseToolArguments } from './http.ts';
import { openAiChatAdapter } from './openai-chat.ts';
import { readSse } from './sse.ts';
import type { ChatMessage, ChatRequest, ContentBlock, ProviderAdapter, StreamEvent } from './types.ts';

/**
 * OpenAI Responses API (official OpenAI endpoint). Requests use store=false so conversations are not
 * stored server-side by the app's requests; reasoning state is replayed within a tool loop when enabled.
 */

type OutputItem = Record<string, unknown> & { type?: string };

function inputPart(block: ContentBlock): unknown {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'image') return { type: 'input_image', image_url: `data:${block.mimeType};base64,${block.dataBase64}` };
  return { type: 'input_file', filename: block.filename, file_data: `data:application/pdf;base64,${block.dataBase64}` };
}

/** Prepare output items from a previous response for stateless replay. */
function replayable(items: OutputItem[]): OutputItem[] {
  const out: OutputItem[] = [];
  for (const item of items) {
    if (item.type === 'reasoning') {
      if (item.encrypted_content) out.push(item);
      continue;
    }
    const { id: _id, status: _status, ...rest } = item;
    out.push(rest);
  }
  return out;
}

export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ role: 'user', content: m.content.map(inputPart) });
    } else if (m.role === 'assistant') {
      const state = m.providerState?.protocol === 'openai_responses' ? (m.providerState.data as { outputItems?: OutputItem[] }) : null;
      if (state?.outputItems?.length) {
        items.push(...replayable(state.outputItems));
      } else {
        if (m.text) items.push({ role: 'assistant', content: m.text });
        for (const tc of m.toolCalls ?? []) {
          items.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) });
        }
      }
    } else {
      for (const r of m.results) items.push({ type: 'function_call_output', call_id: r.toolCallId, output: r.content || '(no output)' });
    }
  }
  return items;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: OutputItem;
  message?: string;
  code?: string;
  response?: {
    status?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
  };
}

export const openAiResponsesAdapter: ProviderAdapter = {
  protocol: 'openai_responses',

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const { connection, model } = req;
    const body: Record<string, unknown> = {
      model: model.apiModelId,
      input: toResponsesInput(req.messages),
      stream: true,
      store: false,
      max_output_tokens: req.maxOutputTokens,
    };
    if (req.system) body.instructions = req.system;
    if (model.params.temperature !== undefined) body.temperature = model.params.temperature;
    if (model.params.reasoningEffort) {
      body.reasoning = { effort: model.params.reasoningEffort };
      body.include = ['reasoning.encrypted_content'];
    }
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    }
    const response = await openStream({
      url: joinUrl(connection.baseUrl, 'responses'),
      headers: { ...connection.extraHeaders, ...authHeaders(connection.protocol, connection.authType, req.credential) },
      body,
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType, modelId: model.apiModelId },
    });

    const outputItems: OutputItem[] = [];
    let stopReason: 'end' | 'max_tokens' | 'other' = 'end';
    for await (const message of readSse(response.body, { signal: req.signal, providerName: connection.name })) {
      let event: ResponsesEvent;
      try {
        event = JSON.parse(message.data) as ResponsesEvent;
      } catch {
        continue;
      }
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (event.delta) yield { type: 'text', text: event.delta };
          break;
        case 'response.output_item.done':
          if (event.item) {
            outputItems.push(event.item);
            if (event.item.type === 'function_call') {
              yield {
                type: 'tool_call',
                call: {
                  id: String(event.item.call_id ?? event.item.id ?? `call_${outputItems.length}`),
                  name: String(event.item.name ?? ''),
                  input: parseToolArguments(event.item.arguments),
                },
              };
            }
          }
          break;
        case 'response.completed':
        case 'response.incomplete': {
          const usage = event.response?.usage;
          if (usage) yield { type: 'usage', inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null };
          if (event.type === 'response.incomplete' || event.response?.status === 'incomplete') {
            stopReason = event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other';
          }
          break;
        }
        case 'response.failed': {
          const e = event.response?.error;
          throw new ProviderError(
            e?.code === 'rate_limit_exceeded' ? 'rate_limit' : 'server',
            `${connection.name} reported an error: ${e?.message ?? 'the response failed'}`,
          );
        }
        case 'error':
          throw new ProviderError('server', `${connection.name} reported an error: ${event.message ?? event.code ?? 'unknown error'}`);
        default:
          break;
      }
    }
    const hasCalls = outputItems.some((i) => i.type === 'function_call');
    yield {
      type: 'done',
      stopReason: hasCalls ? 'tool_use' : stopReason,
      providerState: { protocol: 'openai_responses', data: { outputItems } },
    };
  },

  // The official OpenAI API lists models at the same /models endpoint as compatible servers.
  listModels: openAiChatAdapter.listModels,
};
