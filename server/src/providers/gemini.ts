import { authHeaders } from './credentials.ts';
import { ProviderError } from './errors.ts';
import { getJson, joinUrl, openStream } from './http.ts';
import { readSse } from './sse.ts';
import type { ChatMessage, ChatRequest, ContentBlock, ListedModel, ListModelsRequest, ProviderAdapter, StreamEvent, ToolCall } from './types.ts';

/**
 * Google Gemini API via generateContent / streamGenerateContent (stateless).
 * Model parts — including any thoughtSignature metadata — are replayed exactly as received within a tool loop.
 */

type Part = Record<string, unknown>;

function userPart(block: ContentBlock): Part {
  if (block.type === 'text') return { text: block.text };
  if (block.type === 'image') return { inlineData: { mimeType: block.mimeType, data: block.dataBase64 } };
  return { inlineData: { mimeType: 'application/pdf', data: block.dataBase64 } };
}

const SYNTHETIC_ID = /^gemini_call_\d+$/;

export function toGeminiContents(messages: ChatMessage[]): { role: 'user' | 'model'; parts: Part[] }[] {
  const out: { role: 'user' | 'model'; parts: Part[] }[] = [];
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    const clean = parts.filter((p) => !(typeof p.text === 'string' && p.text === '' && !p.thoughtSignature));
    if (clean.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.parts.push(...clean);
    else out.push({ role, parts: clean });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', m.content.map(userPart));
    else if (m.role === 'assistant') {
      const state = m.providerState?.protocol === 'gemini_generate_content' ? (m.providerState.data as { parts?: Part[] }) : null;
      if (state?.parts?.length) push('model', state.parts);
      else {
        push('model', [
          { text: m.text },
          ...(m.toolCalls ?? []).map((tc) => ({
            functionCall: { name: tc.name, args: tc.input, ...(SYNTHETIC_ID.test(tc.id) ? {} : { id: tc.id }) },
          })),
        ]);
      }
    } else {
      push(
        'user',
        m.results.map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.isError ? { error: r.content } : { result: r.content },
            ...(SYNTHETIC_ID.test(r.toolCallId) ? {} : { id: r.toolCallId }),
          },
        })),
      );
    }
  }
  return out;
}

interface GeminiChunk {
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function modelPath(apiModelId: string): string {
  return `models/${apiModelId.replace(/^models\//, '')}`;
}

export const geminiAdapter: ProviderAdapter = {
  protocol: 'gemini_generate_content',

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const { connection, model } = req;
    const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens };
    if (model.params.temperature !== undefined) generationConfig.temperature = model.params.temperature;
    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages), generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools.length > 0) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    const response = await openStream({
      url: `${joinUrl(connection.baseUrl, `${modelPath(model.apiModelId)}:streamGenerateContent`)}?alt=sse`,
      headers: { ...connection.extraHeaders, ...authHeaders(connection.protocol, connection.authType, req.credential) },
      body,
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType, modelId: model.apiModelId },
    });

    const rawParts: Part[] = [];
    const calls: ToolCall[] = [];
    let finish: string | null = null;
    let usage: GeminiChunk['usageMetadata'] | null = null;
    let sawText = false;
    for await (const message of readSse(response.body, { signal: req.signal, providerName: connection.name })) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(message.data) as GeminiChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError('server', `${connection.name} reported an error: ${chunk.error.message ?? chunk.error.status}`);
      if (chunk.promptFeedback?.blockReason) {
        throw new ProviderError('blocked', `Gemini declined to answer this request (${chunk.promptFeedback.blockReason}).`, { retryable: false });
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall && typeof part.functionCall === 'object') {
          rawParts.push(part);
          const fc = part.functionCall as { name?: string; args?: Record<string, unknown>; id?: string };
          calls.push({ id: fc.id ?? `gemini_call_${calls.length}`, name: fc.name ?? '', input: fc.args ?? {} });
        } else if (typeof part.text === 'string') {
          if (!part.thought && part.text) {
            sawText = true;
            yield { type: 'text', text: part.text };
          }
          const last = rawParts.at(-1);
          const mergeable =
            last && typeof last.text === 'string' && !last.thoughtSignature && !part.thoughtSignature && Boolean(last.thought) === Boolean(part.thought);
          if (mergeable) last.text = `${last.text as string}${part.text}`;
          else rawParts.push({ ...part });
        } else {
          rawParts.push(part);
        }
      }
      if (candidate?.finishReason) finish = candidate.finishReason;
    }
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.promptTokenCount ?? null,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) || null,
      };
    }
    if (finish && BLOCKED_FINISH.has(finish) && !sawText && calls.length === 0) {
      throw new ProviderError('blocked', `Gemini stopped without answering (${finish}).`, { retryable: false });
    }
    for (const call of calls) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      stopReason: calls.length > 0 ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish && finish !== 'STOP' ? 'other' : 'end',
      providerState: { protocol: 'gemini_generate_content', data: { parts: rawParts } },
      notice: finish && BLOCKED_FINISH.has(finish) ? `Gemini stopped early (${finish}).` : undefined,
    };
  },

  async listModels(req: ListModelsRequest): Promise<ListedModel[]> {
    const { connection } = req;
    const json = await getJson<{
      models?: { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[];
    }>({
      url: `${joinUrl(connection.baseUrl, 'models')}?pageSize=1000`,
      headers: { ...connection.extraHeaders, ...authHeaders(connection.protocol, connection.authType, req.credential) },
      signal: req.signal,
      fetchImpl: req.fetchImpl,
      errorContext: { connectionName: connection.name, authType: connection.authType },
      headersTimeoutMs: 30_000,
    });
    if (!Array.isArray(json.models)) throw new ProviderError('bad_response', `${connection.name} didn't return a model list.`);
    return json.models
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        apiModelId: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? m.name.replace(/^models\//, ''),
        contextWindow: m.inputTokenLimit,
        maxOutputTokens: m.outputTokenLimit,
      }));
  },
};
