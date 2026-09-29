import type { AccessType, AuthType, ConnectionStatus, ModelDto, Protocol } from '../../../shared/types.ts';

/** Provider connection as the provider layer sees it (no secrets). */
export interface ConnectionRecord {
  id: string;
  name: string;
  preset: string;
  protocol: Protocol;
  accessType: AccessType;
  baseUrl: string;
  authType: AuthType;
  tokenCommand: string[] | null;
  extraHeaders: Record<string, string>;
  status: ConnectionStatus;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string }
  | { type: 'pdf'; filename: string; dataBase64: string };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Opaque provider-specific data (reasoning items, thought signatures) replayed within one tool loop. */
export interface ProviderState {
  protocol: Protocol;
  data: unknown;
}

export type ChatMessage =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[]; providerState?: ProviderState }
  | { role: 'tool'; results: ToolResultBlock[] };

/** JSON-schema subset that every supported protocol accepts. */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  connection: ConnectionRecord;
  model: ModelDto;
  credential: string | null;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'other';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'done'; stopReason: StopReason; providerState?: ProviderState; notice?: string };

export interface ListedModel {
  apiModelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ListModelsRequest {
  connection: ConnectionRecord;
  credential: string | null;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}

export interface ProviderAdapter {
  readonly protocol: Protocol;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
  listModels(request: ListModelsRequest): Promise<ListedModel[]>;
}
