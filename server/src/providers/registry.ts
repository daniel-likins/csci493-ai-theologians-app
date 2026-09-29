import type { Protocol } from '../../../shared/types.ts';
import { anthropicAdapter } from './anthropic.ts';
import { geminiAdapter } from './gemini.ts';
import { openAiChatAdapter } from './openai-chat.ts';
import { openAiResponsesAdapter } from './openai-responses.ts';
import type { ProviderAdapter } from './types.ts';

/** One adapter per wire protocol. A new model on a supported protocol needs only Settings, not code. */
const ADAPTERS: Record<Protocol, ProviderAdapter> = {
  openai_responses: openAiResponsesAdapter,
  openai_chat: openAiChatAdapter,
  anthropic_messages: anthropicAdapter,
  gemini_generate_content: geminiAdapter,
};

export function adapterFor(protocol: Protocol): ProviderAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error(`No adapter for protocol ${protocol}`);
  return adapter;
}

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai_responses: 'OpenAI Responses API',
  openai_chat: 'OpenAI-compatible Chat Completions',
  anthropic_messages: 'Anthropic Messages API',
  gemini_generate_content: 'Gemini generateContent API',
};
