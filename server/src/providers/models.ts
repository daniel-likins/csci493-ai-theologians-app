import type { ModelDto, ModelParams } from '../../../shared/types.ts';
import { parseJson, toBool, type Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';

interface ModelRow {
  id: string;
  connection_id: string;
  api_model_id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  supports_streaming: number;
  supports_tools: number;
  supports_images: number;
  supports_pdfs: number;
  params_json: string;
  enabled: number;
  sort_order: number;
}

export interface ModelInput {
  apiModelId?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsPdfs?: boolean;
  params?: ModelParams;
  enabled?: boolean;
}

function toModel(row: ModelRow): ModelDto {
  return {
    id: row.id,
    connectionId: row.connection_id,
    apiModelId: row.api_model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    supportsStreaming: toBool(row.supports_streaming),
    supportsTools: toBool(row.supports_tools),
    supportsImages: toBool(row.supports_images),
    supportsPdfs: toBool(row.supports_pdfs),
    params: parseJson<ModelParams>(row.params_json, {}),
    enabled: toBool(row.enabled),
    sortOrder: row.sort_order,
  };
}

function validate(model: ModelDto): void {
  if (!model.apiModelId.trim()) throw badRequest('Enter the model ID exactly as the provider names it.');
  if (model.apiModelId.length > 200) throw badRequest('Model IDs can be at most 200 characters.');
  if (!model.displayName.trim()) throw badRequest('A model needs a display name.');
  if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 10_000_000) {
    throw badRequest('Context window must be a whole number of tokens between 1,024 and 10,000,000.');
  }
  if (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 16 || model.maxOutputTokens > 1_000_000) {
    throw badRequest('Max output must be a whole number of tokens between 16 and 1,000,000.');
  }
  if (model.maxOutputTokens >= model.contextWindow) throw badRequest('Max output must be smaller than the context window.');
  const t = model.params.temperature;
  if (t !== undefined && (typeof t !== 'number' || t < 0 || t > 2)) throw badRequest('Temperature must be between 0 and 2.');
  const e = model.params.reasoningEffort;
  if (e !== undefined && !['low', 'medium', 'high'].includes(e)) throw badRequest('Reasoning effort must be low, medium, or high.');
}

/** Models and their declared capabilities. Capabilities are user-declared; nothing is assumed. */
export class ModelService {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  list(): ModelDto[] {
    return this.#db.all<ModelRow>('SELECT * FROM models ORDER BY connection_id, sort_order, display_name COLLATE NOCASE').map(toModel);
  }

  listByConnection(connectionId: string): ModelDto[] {
    return this.#db
      .all<ModelRow>('SELECT * FROM models WHERE connection_id = ? ORDER BY sort_order, display_name COLLATE NOCASE', connectionId)
      .map(toModel);
  }

  find(id: string): ModelDto | null {
    const row = this.#db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id);
    return row ? toModel(row) : null;
  }

  get(id: string): ModelDto {
    const model = this.find(id);
    if (!model) throw notFound('Model');
    return model;
  }

  create(connectionId: string, input: ModelInput & { apiModelId: string }): ModelDto {
    if (!this.#db.get('SELECT id FROM provider_connections WHERE id = ?', connectionId)) throw notFound('Connection');
    const apiModelId = input.apiModelId.trim();
    if (this.#db.get('SELECT id FROM models WHERE connection_id = ? AND api_model_id = ?', connectionId, apiModelId)) {
      throw conflict(`“${apiModelId}” is already added to this connection.`);
    }
    const contextWindow = input.contextWindow ?? 32_000;
    const model: ModelDto = {
      id: newId(),
      connectionId,
      apiModelId,
      displayName: input.displayName?.trim() || apiModelId,
      contextWindow,
      maxOutputTokens: input.maxOutputTokens ?? Math.min(4096, Math.floor(contextWindow / 4)),
      supportsStreaming: input.supportsStreaming ?? true,
      supportsTools: input.supportsTools ?? false,
      supportsImages: input.supportsImages ?? false,
      supportsPdfs: input.supportsPdfs ?? false,
      params: input.params ?? {},
      enabled: input.enabled ?? true,
      sortOrder: (this.#db.get<{ n: number | null }>('SELECT MAX(sort_order) n FROM models WHERE connection_id = ?', connectionId)?.n ?? -1) + 1,
    };
    validate(model);
    const now = nowIso();
    this.#db.run(
      `INSERT INTO models (id, connection_id, api_model_id, display_name, context_window, max_output_tokens, supports_streaming,
         supports_tools, supports_images, supports_pdfs, params_json, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      model.id,
      connectionId,
      model.apiModelId,
      model.displayName,
      model.contextWindow,
      model.maxOutputTokens,
      model.supportsStreaming,
      model.supportsTools,
      model.supportsImages,
      model.supportsPdfs,
      JSON.stringify(model.params),
      model.enabled,
      model.sortOrder,
      now,
      now,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'models' });
    return this.get(model.id);
  }

  update(id: string, patch: ModelInput): ModelDto {
    const current = this.get(id);
    const next: ModelDto = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      params: patch.params ?? current.params,
    } as ModelDto;
    next.apiModelId = next.apiModelId.trim();
    next.displayName = next.displayName.trim();
    validate(next);
    if (next.apiModelId !== current.apiModelId) {
      const dupe = this.#db.get('SELECT id FROM models WHERE connection_id = ? AND api_model_id = ? AND id != ?', current.connectionId, next.apiModelId, id);
      if (dupe) throw conflict(`“${next.apiModelId}” is already added to this connection.`);
    }
    this.#db.run(
      `UPDATE models SET api_model_id = ?, display_name = ?, context_window = ?, max_output_tokens = ?, supports_streaming = ?,
         supports_tools = ?, supports_images = ?, supports_pdfs = ?, params_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      next.apiModelId,
      next.displayName,
      next.contextWindow,
      next.maxOutputTokens,
      next.supportsStreaming,
      next.supportsTools,
      next.supportsImages,
      next.supportsPdfs,
      JSON.stringify(next.params),
      next.enabled,
      nowIso(),
      id,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'models' });
    return this.get(id);
  }

  /** Past messages keep their model label; conversations that selected this model fall back to the assistant's model. */
  delete(id: string): void {
    this.get(id);
    this.#db.run('DELETE FROM models WHERE id = ?', id);
    this.#bus.publish({ type: 'settings.changed', area: 'models' });
  }
}
