import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthType, Protocol } from '../../shared/types.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createAppContext, type AppContext } from '../src/context.ts';
import type { SuggestionLimits } from '../src/memory/suggestions.ts';
import { MemorySecretStore } from '../src/secrets/secret-store.ts';

export const TEST_PORT = 47950;

export interface RecordedRequest {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

export interface TestEnv {
  ctx: AppContext;
  dir: string;
  secrets: MemorySecretStore;
  requests: RecordedRequest[];
  setFetch(handler: typeof fetch): void;
  close(): Promise<void>;
  reopen(): TestEnv;
  cleanup(): Promise<void>;
}

interface EnvOptions {
  dir?: string;
  secrets?: MemorySecretStore;
  suggestionLimits?: Partial<SuggestionLimits>;
  config?: Partial<AppConfig>;
}

/** A fully wired app on a temporary data folder, with in-memory secrets and no real network. */
export function createTestEnv(options: EnvOptions = {}): TestEnv {
  const dir = options.dir ?? mkdtempSync(path.join(os.tmpdir(), 'theologians-test-'));
  const config = loadConfig(
    { mode: 'test', dataDir: dir, port: TEST_PORT, idleShutdownMinutes: null, extraAllowedOrigins: [], keychainService: 'Theologians (test)', ...options.config },
    {},
    [],
  );
  const secrets = options.secrets ?? new MemorySecretStore();
  const requests: RecordedRequest[] = [];
  let handler: typeof fetch = async (input) => {
    throw new TypeError(`fetch failed (network is disabled in tests): ${String(input)}`);
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url: String(input), method: init?.method ?? 'GET', body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return handler(input, init);
  };
  const ctx = createAppContext(config, {
    secrets,
    fetchImpl,
    suggestionLimits: { idleDelayMs: 60 * 60_000, ...options.suggestionLimits },
  });
  let closed = false;
  const env: TestEnv = {
    ctx,
    dir,
    secrets,
    requests,
    setFetch: (h) => {
      handler = h;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      ctx.generation.cancelAll();
      await ctx.generation.idle();
      ctx.suggestions.cancelAll();
      ctx.backups.stop();
      ctx.db.close();
    },
    reopen: () => createTestEnv({ ...options, dir, secrets }),
    cleanup: async () => {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}

export async function waitFor<T>(check: () => T | null | undefined | false, label = 'condition', timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function addModel(
  ctx: AppContext,
  options: {
    connectionName?: string;
    protocol?: Protocol;
    baseUrl?: string;
    authType?: AuthType;
    secret?: string;
    tokenCommand?: string[];
    apiModelId?: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsTools?: boolean;
    supportsImages?: boolean;
    supportsPdfs?: boolean;
  } = {},
) {
  const connection = await ctx.connections.create(
    {
      name: options.connectionName ?? 'Test endpoint',
      protocol: options.protocol ?? 'openai_chat',
      accessType: 'local',
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:59999/v1',
      authType: options.authType ?? 'none',
      tokenCommand: options.tokenCommand,
    },
    options.secret,
  );
  const model = ctx.models.create(connection.id, {
    apiModelId: options.apiModelId ?? 'mock-model',
    displayName: options.displayName ?? 'Mock Model',
    contextWindow: options.contextWindow ?? 32_000,
    maxOutputTokens: options.maxOutputTokens ?? 1024,
    supportsTools: options.supportsTools ?? true,
    supportsImages: options.supportsImages ?? false,
    supportsPdfs: options.supportsPdfs ?? false,
  });
  return { connection, model };
}

/** The system prompt sent in an OpenAI-compatible Chat Completions request. */
export function systemPromptOf(request: RecordedRequest): string {
  return request.body?.messages?.[0]?.role === 'system' ? String(request.body.messages[0].content) : '';
}

export function chatRequests(env: TestEnv): RecordedRequest[] {
  return env.requests.filter((r) => r.url.endsWith('/chat/completions'));
}
