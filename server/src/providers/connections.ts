import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AccessType,
  AuthType,
  ConnectionDto,
  ConnectionStatus,
  DiscoveredModel,
  Protocol,
  ProviderPresetDto,
} from '../../../shared/types.ts';
import { DEFAULTS_DIR } from '../config.ts';
import { parseJson, type Db } from '../db/database.ts';
import type { UsageService } from '../domain/usage.ts';
import type { EventBus } from '../events/bus.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import { authHeaders, secretAccount, type CredentialResolver } from './credentials.ts';
import { ProviderError } from './errors.ts';
import { getJson, isLocalHost, joinUrl } from './http.ts';
import type { ModelService } from './models.ts';
import { adapterFor } from './registry.ts';
import type { ConnectionRecord, ListedModel } from './types.ts';

interface ConnectionRow {
  id: string;
  name: string;
  preset: string;
  protocol: Protocol;
  access_type: AccessType;
  base_url: string;
  auth_type: AuthType;
  token_command_json: string | null;
  extra_headers_json: string;
  status: ConnectionStatus;
  status_detail: string | null;
  last_tested_at: string | null;
  last_verified_at: string | null;
}

export interface ConnectionInput {
  name: string;
  preset?: string;
  protocol: Protocol;
  accessType: AccessType;
  baseUrl: string;
  authType: AuthType;
  tokenCommand?: string[] | null;
  extraHeaders?: Record<string, string>;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: ConnectionStatus;
  detail: string;
  models: DiscoveredModel[];
}

export interface ModelTestResult {
  ok: boolean;
  detail: string;
  text: string | null;
  latencyMs: number | null;
}

const PROTOCOLS: Protocol[] = ['openai_responses', 'openai_chat', 'anthropic_messages', 'gemini_generate_content'];
const ACCESS_TYPES: AccessType[] = ['paid_api', 'institutional', 'local', 'other'];
const AUTH_TYPES: AuthType[] = ['api_key', 'bearer_token', 'token_command', 'none'];
const RESERVED_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'host', 'content-length', 'content-type']);

export function loadPresets(dir = DEFAULTS_DIR): ProviderPresetDto[] {
  return JSON.parse(readFileSync(path.join(dir, 'provider-presets.json'), 'utf8')) as ProviderPresetDto[];
}

export function validateConnectionInput(input: ConnectionInput): ConnectionInput {
  const name = input.name?.trim();
  if (!name) throw badRequest('A connection needs a name.');
  if (name.length > 80) throw badRequest('Connection names can be at most 80 characters.');
  if (!PROTOCOLS.includes(input.protocol)) throw badRequest('Unknown protocol.');
  if (!ACCESS_TYPES.includes(input.accessType)) throw badRequest('Unknown access type.');
  if (!AUTH_TYPES.includes(input.authType)) throw badRequest('Unknown authentication method.');

  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    throw badRequest('Enter a full base URL, for example https://api.example.com/v1');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('The base URL must start with https:// or http://');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw badRequest("Use https:// for remote endpoints so credentials and conversations aren't sent unencrypted.");
  }
  if (url.username || url.password) throw badRequest("Don't put credentials in the URL; use the key or token field.");
  url.hash = '';
  const baseUrl = url.toString().replace(/\/+$/, '');

  let tokenCommand: string[] | null = null;
  if (input.authType === 'token_command') {
    const cmd = input.tokenCommand;
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > 20 || !cmd[0]?.trim()) {
      throw badRequest('Enter the command that prints an access token, one argument per line.');
    }
    if (cmd.some((a) => typeof a !== 'string' || a.length > 1024 || a.includes('\0'))) throw badRequest('Invalid token command.');
    tokenCommand = cmd.map((a) => a.trim()).filter((a, i) => i === 0 || a.length > 0);
  }

  const extraHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.extraHeaders ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw badRequest(`Invalid header name “${key}”.`);
    if (RESERVED_HEADERS.has(key.toLowerCase())) {
      throw badRequest(`“${key}” can't be set as an extra header. Put credentials in the key or token field so they're stored in your OS credential store.`);
    }
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) throw badRequest(`Invalid value for header “${key}”.`);
    extraHeaders[key] = value;
  }
  if (Object.keys(extraHeaders).length > 20) throw badRequest('At most 20 extra headers.');

  return { ...input, name, baseUrl, tokenCommand, extraHeaders, preset: input.preset ?? 'custom' };
}

function alcfListEndpointsUrl(baseUrl: string): string | null {
  const m = /^(https:\/\/[^/]+)\/resource_server\//.exec(baseUrl);
  return m ? `${m[1]}/resource_server/list-endpoints` : null;
}

function collectModelIds(json: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || found.size > 500) return;
    if (typeof value === 'string') {
      if (/^[\w.-]+\/[\w.:-]+$/.test(value) && !value.startsWith('http')) found.add(value);
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  visit(json, 0);
  return [...found].sort();
}

export class ConnectionService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #secrets: SecretStore;
  readonly #credentials: CredentialResolver;
  readonly #models: ModelService;
  readonly #usage: UsageService;
  readonly #fetch: typeof fetch;
  readonly #presets: ProviderPresetDto[];
  readonly #hasSecret = new Map<string, boolean>();

  constructor(deps: {
    db: Db;
    bus: EventBus;
    secrets: SecretStore;
    credentials: CredentialResolver;
    models: ModelService;
    usage: UsageService;
    fetchImpl: typeof fetch;
    presets: ProviderPresetDto[];
  }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#secrets = deps.secrets;
    this.#credentials = deps.credentials;
    this.#models = deps.models;
    this.#usage = deps.usage;
    this.#fetch = deps.fetchImpl;
    this.#presets = deps.presets;
  }

  presets(): ProviderPresetDto[] {
    return this.#presets;
  }

  #row(id: string): ConnectionRow {
    const row = this.#db.get<ConnectionRow>('SELECT * FROM provider_connections WHERE id = ?', id);
    if (!row) throw notFound('Connection');
    return row;
  }

  record(id: string): ConnectionRecord {
    const row = this.#row(id);
    return {
      id: row.id,
      name: row.name,
      preset: row.preset,
      protocol: row.protocol,
      accessType: row.access_type,
      baseUrl: row.base_url,
      authType: row.auth_type,
      tokenCommand: parseJson<string[] | null>(row.token_command_json, null),
      extraHeaders: parseJson<Record<string, string>>(row.extra_headers_json, {}),
      status: row.status,
    };
  }

  async #hasSecretFor(row: ConnectionRow): Promise<boolean> {
    if (row.auth_type !== 'api_key' && row.auth_type !== 'bearer_token') return false;
    const cached = this.#hasSecret.get(row.id);
    if (cached !== undefined) return cached;
    let has = false;
    try {
      has = (await this.#secrets.get(secretAccount(row.id))) !== null;
    } catch {
      has = false;
    }
    this.#hasSecret.set(row.id, has);
    return has;
  }

  async #toDto(row: ConnectionRow): Promise<ConnectionDto> {
    const record = this.record(row.id);
    return {
      id: row.id,
      name: row.name,
      preset: row.preset,
      protocol: row.protocol,
      accessType: row.access_type,
      baseUrl: row.base_url,
      authType: row.auth_type,
      tokenCommand: record.tokenCommand,
      extraHeaders: record.extraHeaders,
      status: row.status,
      statusDetail: row.status_detail,
      lastTestedAt: row.last_tested_at,
      lastVerifiedAt: row.last_verified_at,
      hasSecret: await this.#hasSecretFor(row),
    };
  }

  async list(): Promise<ConnectionDto[]> {
    const rows = this.#db.all<ConnectionRow>('SELECT * FROM provider_connections ORDER BY created_at');
    return Promise.all(rows.map((r) => this.#toDto(r)));
  }

  async get(id: string): Promise<ConnectionDto> {
    return this.#toDto(this.#row(id));
  }

  async create(input: ConnectionInput, secret?: string): Promise<ConnectionDto> {
    const clean = validateConnectionInput(input);
    const id = newId();
    const now = nowIso();
    const needsSecret = clean.authType === 'api_key' || clean.authType === 'bearer_token';
    this.#db.run(
      `INSERT INTO provider_connections (id, name, preset, protocol, access_type, base_url, auth_type, token_command_json,
         extra_headers_json, status, status_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      clean.name,
      clean.preset ?? 'custom',
      clean.protocol,
      clean.accessType,
      clean.baseUrl,
      clean.authType,
      clean.tokenCommand ? JSON.stringify(clean.tokenCommand) : null,
      JSON.stringify(clean.extraHeaders ?? {}),
      needsSecret && !secret ? 'needs_credentials' : 'unverified',
      needsSecret && !secret ? 'Add a key or token to use this connection.' : 'Not tested yet.',
      now,
      now,
    );
    this.#hasSecret.set(id, false);
    if (secret) {
      try {
        await this.setSecret(id, secret);
      } catch (err) {
        this.#db.run('DELETE FROM provider_connections WHERE id = ?', id);
        throw err;
      }
    }
    this.#bus.publish({ type: 'settings.changed', area: 'connections' });
    return this.get(id);
  }

  async update(id: string, patch: Partial<ConnectionInput>): Promise<ConnectionDto> {
    const current = this.record(id);
    const merged = validateConnectionInput({
      name: patch.name ?? current.name,
      preset: current.preset,
      protocol: patch.protocol ?? current.protocol,
      accessType: patch.accessType ?? current.accessType,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      authType: patch.authType ?? current.authType,
      tokenCommand: patch.tokenCommand !== undefined ? patch.tokenCommand : current.tokenCommand,
      extraHeaders: patch.extraHeaders ?? current.extraHeaders,
    });
    const endpointChanged =
      merged.protocol !== current.protocol ||
      merged.baseUrl !== current.baseUrl ||
      merged.authType !== current.authType ||
      JSON.stringify(merged.tokenCommand) !== JSON.stringify(current.tokenCommand) ||
      JSON.stringify(merged.extraHeaders) !== JSON.stringify(current.extraHeaders);
    this.#db.run(
      `UPDATE provider_connections SET name = ?, protocol = ?, access_type = ?, base_url = ?, auth_type = ?, token_command_json = ?,
         extra_headers_json = ?, updated_at = ? WHERE id = ?`,
      merged.name,
      merged.protocol,
      merged.accessType,
      merged.baseUrl,
      merged.authType,
      merged.tokenCommand ? JSON.stringify(merged.tokenCommand) : null,
      JSON.stringify(merged.extraHeaders ?? {}),
      nowIso(),
      id,
    );
    if (endpointChanged) {
      this.#credentials.invalidate(id);
      this.setStatus(id, 'unverified', 'Settings changed — not tested yet.');
    }
    this.#bus.publish({ type: 'settings.changed', area: 'connections' });
    return this.get(id);
  }

  async setSecret(id: string, secret: string): Promise<ConnectionDto> {
    const row = this.#row(id);
    if (row.auth_type !== 'api_key' && row.auth_type !== 'bearer_token') {
      throw badRequest('This connection does not use a stored key or token.');
    }
    await this.#secrets.set(secretAccount(id), secret.trim());
    this.#hasSecret.set(id, true);
    this.#credentials.invalidate(id);
    this.setStatus(id, 'unverified', `Credential saved in the ${this.#secrets.description} — not tested yet.`);
    return this.get(id);
  }

  async clearSecret(id: string): Promise<ConnectionDto> {
    this.#row(id);
    await this.#secrets.delete(secretAccount(id));
    this.#hasSecret.set(id, false);
    this.#credentials.invalidate(id);
    this.setStatus(id, 'needs_credentials', 'Credential removed.');
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    this.#row(id);
    await this.#secrets.delete(secretAccount(id));
    this.#hasSecret.delete(id);
    this.#credentials.invalidate(id);
    this.#db.run('DELETE FROM provider_connections WHERE id = ?', id);
    this.#bus.publish({ type: 'settings.changed', area: 'connections' });
    this.#bus.publish({ type: 'settings.changed', area: 'models' });
  }

  setStatus(id: string, status: ConnectionStatus, detail: string | null, tested = false): void {
    const now = nowIso();
    this.#db.run(
      `UPDATE provider_connections SET status = ?, status_detail = ?,
         last_tested_at = CASE WHEN ? THEN ? ELSE last_tested_at END,
         last_verified_at = CASE WHEN ? THEN ? ELSE last_verified_at END
       WHERE id = ?`,
      status,
      detail,
      tested,
      now,
      status === 'verified',
      now,
      id,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'connections' });
  }

  /** Record the outcome of a real request so Settings reflects expired or rejected credentials. */
  noteRequestFailure(id: string, err: unknown): void {
    if (!(err instanceof ProviderError)) return;
    if (err.kind === 'credential_missing') this.setStatus(id, 'needs_credentials', err.message);
    else if (err.kind === 'expired' || err.kind === 'token_command_failed') this.setStatus(id, 'expired', err.message);
    else if (err.kind === 'auth' || err.kind === 'permission') this.setStatus(id, 'error', err.message);
  }

  noteRequestSuccess(id: string, modelName: string): void {
    const row = this.#row(id);
    if (row.status !== 'verified') this.setStatus(id, 'verified', `Working — last response from ${modelName}.`, true);
  }

  #fail(connection: ConnectionRecord, err: unknown): ConnectionTestResult {
    const message = err instanceof Error ? err.message : String(err);
    let status: ConnectionStatus = 'error';
    if (err instanceof ProviderError) {
      if (err.kind === 'credential_missing') status = 'needs_credentials';
      else if (err.kind === 'expired' || err.kind === 'token_command_failed') status = 'expired';
    }
    this.setStatus(connection.id, status, message, true);
    this.#usage.record({ purpose: 'connection_test', status: 'error', detail: `${connection.name}: ${message.slice(0, 200)}` });
    return { ok: false, status, detail: message, models: [] };
  }

  #discovered(connectionId: string, listed: ListedModel[]): DiscoveredModel[] {
    const existing = new Set(this.#models.listByConnection(connectionId).map((m) => m.apiModelId));
    return listed.map((m) => ({ ...m, alreadyAdded: existing.has(m.apiModelId) }));
  }

  /** Verify credentials and endpoint by listing models (no tokens spent). */
  async test(id: string): Promise<ConnectionTestResult> {
    const connection = this.record(id);
    const signal = AbortSignal.timeout(45_000);
    let credential: string | null;
    try {
      credential = await this.#credentials.resolve(connection, { forceRefresh: true });
    } catch (err) {
      return this.#fail(connection, err);
    }
    try {
      const listed = await adapterFor(connection.protocol).listModels({ connection, credential, signal, fetchImpl: this.#fetch });
      const detail = listed.length
        ? `Connected. ${connection.name} listed ${listed.length} model${listed.length === 1 ? '' : 's'}.`
        : `Connected, but ${connection.name} listed no models. Add a model ID manually.`;
      this.setStatus(id, 'verified', detail, true);
      this.#usage.record({ purpose: 'connection_test', status: 'ok', inputTokens: 0, outputTokens: 0, detail: `${connection.name}: listed models` });
      return { ok: true, status: 'verified', detail, models: this.#discovered(id, listed) };
    } catch (err) {
      const listUnavailable = err instanceof ProviderError && ['model_not_found', 'bad_response', 'bad_request'].includes(err.kind);
      const alcfUrl = listUnavailable ? alcfListEndpointsUrl(connection.baseUrl) : null;
      if (alcfUrl) {
        try {
          const json = await getJson<unknown>({
            url: alcfUrl,
            headers: authHeaders(connection.protocol, connection.authType, credential),
            signal,
            fetchImpl: this.#fetch,
            errorContext: { connectionName: connection.name, authType: connection.authType },
            headersTimeoutMs: 30_000,
          });
          const ids = collectModelIds(json);
          const detail = `Authenticated with ALCF. Read ${ids.length} model name${ids.length === 1 ? '' : 's'} from list-endpoints (check which cluster serves each model).`;
          this.setStatus(id, 'verified', detail, true);
          this.#usage.record({ purpose: 'connection_test', status: 'ok', inputTokens: 0, outputTokens: 0, detail: `${connection.name}: list-endpoints` });
          return { ok: true, status: 'verified', detail, models: this.#discovered(id, ids.map((m) => ({ apiModelId: m, displayName: m }))) };
        } catch (err2) {
          return this.#fail(connection, err2);
        }
      }
      if (err instanceof ProviderError && err.kind === 'model_not_found') {
        const detail = `${connection.name} doesn't offer a model list at ${joinUrl(connection.baseUrl, 'models')}. Add a model ID manually, then use “Send test message” to verify the connection.`;
        this.setStatus(id, 'unverified', detail, true);
        return { ok: false, status: 'unverified', detail, models: [] };
      }
      return this.#fail(connection, err);
    }
  }

  /** Send a tiny real request to one model. The model's actual reply is returned and shown. */
  async testModel(modelId: string): Promise<ModelTestResult> {
    const model = this.#models.get(modelId);
    const connection = this.record(model.connectionId);
    const started = Date.now();
    let text = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    const attempt = async (forceRefresh: boolean): Promise<void> => {
      const credential = await this.#credentials.resolve(connection, { forceRefresh });
      const events = adapterFor(connection.protocol).stream({
        connection,
        model,
        credential,
        system: 'This is a connection test from a desktop app.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with just the word OK.' }] }],
        tools: [],
        maxOutputTokens: Math.min(1024, model.maxOutputTokens),
        signal: AbortSignal.timeout(connection.accessType === 'institutional' ? 600_000 : 90_000),
        fetchImpl: this.#fetch,
      });
      for await (const event of events) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'usage') {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }
      }
    };
    try {
      try {
        await attempt(false);
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'expired' && connection.authType === 'token_command' && text === '') {
          await attempt(true);
        } else throw err;
      }
      const latencyMs = Date.now() - started;
      this.setStatus(connection.id, 'verified', `Test message to ${model.displayName} succeeded.`, true);
      this.#usage.record({
        purpose: 'connection_test',
        modelId: model.id,
        modelLabel: model.displayName,
        inputTokens,
        outputTokens,
        estimated: inputTokens === null,
        status: 'ok',
        detail: `${connection.name}: test message`,
      });
      return { ok: true, detail: `Received a reply in ${(latencyMs / 1000).toFixed(1)} s.`, text: text.trim().slice(0, 300) || '(the model returned no text)', latencyMs };
    } catch (err) {
      const result = this.#fail(connection, err);
      return { ok: false, detail: result.detail, text: null, latencyMs: null };
    }
  }

  assertUsable(connectionId: string): ConnectionRecord {
    const record = this.record(connectionId);
    if (!record) throw new AppError('not_found', 'Connection not found.', 404);
    return record;
  }
}
