import type { ModelDto } from '../../../shared/types.ts';
import { AppError } from '../lib/errors.ts';
import type { ConnectionService } from '../providers/connections.ts';
import type { CredentialResolver } from '../providers/credentials.ts';
import { ProviderError } from '../providers/errors.ts';
import type { ModelService } from '../providers/models.ts';
import { adapterFor } from '../providers/registry.ts';
import type { ChatMessage, ConnectionRecord, StreamEvent, ToolSpec } from '../providers/types.ts';

export interface ResolvedModel {
  model: ModelDto;
  connection: ConnectionRecord;
}

export interface RunArgs {
  resolved: ResolvedModel;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

/**
 * Single entry point for calling a model. Always uses exactly the selected connection — there is no
 * fallback to another provider. A token-command credential gets one automatic refresh if the provider
 * says it expired before any output was produced.
 */
export class ModelRunner {
  readonly #connections: ConnectionService;
  readonly #models: ModelService;
  readonly #credentials: CredentialResolver;
  readonly #fetch: typeof fetch;

  constructor(deps: { connections: ConnectionService; models: ModelService; credentials: CredentialResolver; fetchImpl: typeof fetch }) {
    this.#connections = deps.connections;
    this.#models = deps.models;
    this.#credentials = deps.credentials;
    this.#fetch = deps.fetchImpl;
  }

  connectionIdForModel(modelId: string): string | null {
    return this.#models.find(modelId)?.connectionId ?? null;
  }

  resolve(modelId: string): ResolvedModel {
    const model = this.#models.find(modelId);
    if (!model) throw new AppError('model_missing', 'The selected model no longer exists. Choose another model.', 400);
    if (!model.enabled) throw new AppError('model_disabled', `${model.displayName} is turned off in Settings → Models.`, 400);
    return { model, connection: this.#connections.record(model.connectionId) };
  }

  async *stream(args: RunArgs): AsyncGenerator<StreamEvent> {
    const { model, connection } = args.resolved;
    const adapter = adapterFor(connection.protocol);
    let produced = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const credential = await this.#credentials.resolve(connection, { forceRefresh: attempt > 0 });
        const events = adapter.stream({
          connection,
          model,
          credential,
          system: args.system,
          messages: args.messages,
          tools: args.tools ?? [],
          maxOutputTokens: args.maxOutputTokens,
          signal: args.signal,
          fetchImpl: this.#fetch,
        });
        for await (const event of events) {
          produced = true;
          yield event;
        }
        return;
      } catch (err) {
        const refreshable = err instanceof ProviderError && err.kind === 'expired' && connection.authType === 'token_command';
        if (refreshable && !produced && attempt === 0 && !args.signal.aborted) {
          this.#credentials.invalidate(connection.id);
          continue;
        }
        this.#connections.noteRequestFailure(connection.id, err);
        throw err;
      }
    }
  }

  async complete(args: RunArgs): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
    let text = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for await (const event of this.stream({ ...args, tools: [] })) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'usage') {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
    }
    return { text, inputTokens, outputTokens };
  }
}
