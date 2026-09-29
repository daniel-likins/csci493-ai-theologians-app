import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppInfoDto } from '../../shared/types.ts';
import { ContextBuilder } from './assistants/context-builder.ts';
import { ProfileService } from './assistants/profiles.ts';
import { Summarizer } from './assistants/summarizer.ts';
import { BackupService } from './backup/backup-service.ts';
import { ExportImportService } from './backup/export-import.ts';
import { GenerationService } from './chat/generation.ts';
import { ModelRunner } from './chat/model-runner.ts';
import type { AppConfig } from './config.ts';
import { Db } from './db/database.ts';
import { pendingMigrations, runMigrations, schemaVersion } from './db/migrations.ts';
import { loadProfileDefaults, seedDefaults } from './db/seed.ts';
import { ConversationService } from './domain/conversations.ts';
import { PreferencesService } from './domain/preferences.ts';
import { UsageService } from './domain/usage.ts';
import { WorkspaceService } from './domain/workspaces.ts';
import { EventBus } from './events/bus.ts';
import { AppError } from './lib/errors.ts';
import { newId, nowIso } from './lib/ids.ts';
import { MemoryService } from './memory/memory-service.ts';
import { SuggestionScanner, type SuggestionLimits } from './memory/suggestions.ts';
import { ConnectionService, loadPresets } from './providers/connections.ts';
import { CredentialResolver } from './providers/credentials.ts';
import { ModelService } from './providers/models.ts';
import type { SecretStore } from './secrets/secret-store.ts';
import { createTokens, type GuardTokens } from './security/http-guard.ts';
import { Lifecycle } from './system/lifecycle.ts';
import { ApprovalService } from './tools/approvals.ts';
import { AttachmentService } from './tools/attachments.ts';
import { ToolRegistry } from './tools/registry.ts';
import { WebSearchService } from './tools/web-search.ts';
import { WeatherService } from './weather/weather.ts';

/** Every service, wired once. UI, persistence, providers, memory, and tools stay in separate modules. */
export interface AppContext {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  secrets: SecretStore;
  tokens: GuardTokens;
  bootId: string;
  startedAt: string;
  log: (line: string) => void;
  requestShutdown: (reason: string) => void;
  sseClients: Set<ServerResponse>;
  prefs: PreferencesService;
  workspaces: WorkspaceService;
  profiles: ProfileService;
  conversations: ConversationService;
  usage: UsageService;
  models: ModelService;
  credentials: CredentialResolver;
  connections: ConnectionService;
  runner: ModelRunner;
  memory: MemoryService;
  attachments: AttachmentService;
  webSearch: WebSearchService;
  approvals: ApprovalService;
  tools: ToolRegistry;
  summarizer: Summarizer;
  contextBuilder: ContextBuilder;
  suggestions: SuggestionScanner;
  generation: GenerationService;
  weather: WeatherService;
  backups: BackupService;
  transfer: ExportImportService;
  lifecycle: Lifecycle;
}

export interface ContextOptions {
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  tokens?: GuardTokens;
  suggestionLimits?: Partial<SuggestionLimits>;
  onIdle?: () => void;
  log?: (line: string) => void;
}

const DATA_MARKER = '.theologians-data.json';
const OWN_ENTRIES = new Set([DATA_MARKER, 'theologians.db', 'theologians.db-wal', 'theologians.db-shm', 'theologians.db.restoring', 'attachments', 'Backups', 'logs', 'imports', 'service.json', '.DS_Store']);

/**
 * Never mix Theologians' data into a folder another program is using. A folder is usable when it doesn't exist, is empty,
 * carries Theologians' marker file, or contains only names Theologians itself creates.
 */
export function assertDataDirUsable(dataDir: string): void {
  if (!existsSync(dataDir)) return;
  const entries = readdirSync(dataDir);
  if (entries.includes(DATA_MARKER)) return;
  const foreign = entries.filter((name) => !OWN_ENTRIES.has(name));
  if (foreign.length === 0) return;
  throw new AppError(
    'data_dir_in_use',
    `The folder ${dataDir} already contains files Theologians didn't create (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}). To avoid mixing data, Theologians won't use it. Choose a different folder with THEO_DATA_DIR, or move those files.`,
    500,
  );
}

/** Copy the database before upgrading its schema, so an upgrade can always be rolled back. */
function preMigrationBackup(db: Db, config: AppConfig): void {
  let directory = config.defaultBackupDir;
  try {
    const row = db.get<{ value_json: string }>("SELECT value_json FROM preferences WHERE key = 'backup.directory'");
    const value = row ? (JSON.parse(row.value_json) as unknown) : null;
    if (typeof value === 'string') directory = value;
  } catch {
    // older schema without preferences
  }
  const createdAt = nowIso();
  const id = `${createdAt.replace(/[:.]/g, '-')}_before_migration`;
  const target = path.join(directory, 'snapshots', id);
  mkdirSync(target, { recursive: true });
  const copy = path.join(target, 'theologians.db');
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  let hashes: string[] = [];
  try {
    hashes = db.all<{ sha256: string }>('SELECT DISTINCT sha256 FROM attachments').map((r) => r.sha256);
  } catch {
    hashes = [];
  }
  const bytes = readFileSync(copy);
  writeFileSync(
    path.join(target, 'manifest.json'),
    JSON.stringify(
      {
        format: 'theologians-backup',
        formatVersion: 1,
        id,
        createdAt,
        reason: 'before_migration',
        appVersion: config.version,
        schemaVersion: schemaVersion(db),
        dbSha256: createHash('sha256').update(bytes).digest('hex'),
        dbSizeBytes: bytes.length,
        attachments: hashes,
      },
      null,
      2,
    ),
  );
}

export function createAppContext(config: AppConfig, options: ContextOptions): AppContext {
  assertDataDirUsable(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path.join(config.dataDir, DATA_MARKER), JSON.stringify({ app: 'theologians', note: 'This folder holds Theologians data.', createdAt: nowIso() }, null, 2), { flag: 'wx' });
  } catch {
    // already marked
  }
  mkdirSync(config.attachmentsDir, { recursive: true, mode: 0o700 });
  const existed = existsSync(config.dbFile);
  const db = new Db(config.dbFile);
  if (existed && schemaVersion(db) > 0 && pendingMigrations(db).length > 0) preMigrationBackup(db, config);
  runMigrations(db);
  seedDefaults(db);

  const fetchImpl = options.fetchImpl ?? fetch;
  const bus = new EventBus();
  const prefs = new PreferencesService(db, bus);
  const workspaces = new WorkspaceService(db, bus);
  const profiles = new ProfileService(db, bus, loadProfileDefaults());
  const conversations = new ConversationService(db, bus, profiles);
  const usage = new UsageService(db, bus);
  const models = new ModelService(db, bus);
  const credentials = new CredentialResolver(options.secrets);
  const connections = new ConnectionService({ db, bus, secrets: options.secrets, credentials, models, usage, fetchImpl, presets: loadPresets() });
  const runner = new ModelRunner({ connections, models, credentials, fetchImpl });
  const memory = new MemoryService(db, bus, workspaces);
  const attachments = new AttachmentService(db, config.attachmentsDir);
  const webSearch = new WebSearchService({ prefs, secrets: options.secrets, usage, fetchImpl });
  const approvals = new ApprovalService(db, bus);
  const tools = new ToolRegistry({ prefs, webSearch, attachments, memory, conversations, approvals, workspaces, dataDir: config.dataDir });
  const summarizer = new Summarizer({ conversations, runner, usage });
  const contextBuilder = new ContextBuilder({ db, workspaces, memory, conversations, attachments, summarizer });
  const suggestions = new SuggestionScanner({ conversations, workspaces, memory, profiles, runner, usage, limits: options.suggestionLimits });
  const generation = new GenerationService({
    db,
    bus,
    conversations,
    profiles,
    attachments,
    runner,
    contextBuilder,
    tools,
    webSearch,
    usage,
    prefs,
    connections,
    suggestions,
  });
  const weather = new WeatherService({ prefs, bus, fetchImpl });
  const recover = (): void => {
    conversations.markInterruptedGenerations();
    approvals.expireOrphans();
  };
  const isBusy = (): boolean => generation.activeCount > 0;
  const backups = new BackupService({ config, db, prefs, bus, isBusy, onRestored: recover });
  const transfer = new ExportImportService({ config, db, backups, bus, isBusy, onRestored: recover });
  const lifecycle = new Lifecycle(config, () => generation.activeCount, options.onIdle ?? (() => undefined));
  recover();

  return {
    config,
    db,
    bus,
    secrets: options.secrets,
    tokens: options.tokens ?? createTokens(),
    bootId: newId(),
    startedAt: nowIso(),
    log: options.log ?? (() => undefined),
    requestShutdown: () => undefined,
    sseClients: new Set(),
    prefs,
    workspaces,
    profiles,
    conversations,
    usage,
    models,
    credentials,
    connections,
    runner,
    memory,
    attachments,
    webSearch,
    approvals,
    tools,
    summarizer,
    contextBuilder,
    suggestions,
    generation,
    weather,
    backups,
    transfer,
    lifecycle,
  };
}

export function appInfo(ctx: AppContext): AppInfoDto {
  return {
    name: 'Theologians',
    version: ctx.config.version,
    mode: ctx.config.mode,
    port: ctx.config.port,
    dataDir: ctx.config.dataDir,
    dbFile: ctx.config.dbFile,
    schemaVersion: schemaVersion(ctx.db),
    secretStore: ctx.secrets.description,
    idleShutdownMinutes: ctx.config.idleShutdownMinutes,
    startedAt: ctx.startedAt,
    bootId: ctx.bootId,
  };
}
