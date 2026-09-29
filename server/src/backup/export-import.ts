import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import type { ImportPreviewDto } from '../../../shared/types.ts';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { LATEST_SCHEMA_VERSION, schemaVersion } from '../db/migrations.ts';
import { seedDefaults } from '../db/seed.ts';
import type { EventBus } from '../events/bus.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { BackupService } from './backup-service.ts';

/** Tables included in exports, in foreign-key-safe insert order. Secrets are never in the database. */
export const EXPORT_TABLES = [
  'sections',
  'workspaces',
  'workspace_settings',
  'provider_connections',
  'models',
  'assistant_profiles',
  'folders',
  'conversations',
  'messages',
  'attachments',
  'attachment_chunks',
  'memory_items',
  'memory_changes',
  'memory_change_ops',
  'memory_proposals',
  'preferences',
] as const;

type TableName = (typeof EXPORT_TABLES)[number];
type Row = Record<string, unknown>;

const ManifestSchema = z.object({
  format: z.literal('theologians-export'),
  formatVersion: z.literal(1),
  createdAt: z.string(),
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  includesSecrets: z.literal(false),
  counts: z.record(z.string(), z.number()),
  dataSha256: z.string().regex(/^[0-9a-f]{64}$/),
  attachments: z.array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })),
});

const DataSchema = z.object({
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

const PRIMARY_KEYS: Record<TableName, string> = {
  sections: 'id',
  workspaces: 'id',
  workspace_settings: 'workspace_id',
  provider_connections: 'id',
  models: 'id',
  assistant_profiles: 'id',
  folders: 'id',
  conversations: 'id',
  messages: 'id',
  attachments: 'id',
  attachment_chunks: 'id',
  memory_items: 'id',
  memory_changes: 'id',
  memory_change_ops: 'id',
  memory_proposals: 'id',
  preferences: 'key',
};

/** Preferences that describe this machine rather than the user's data. */
const LOCAL_ONLY_PREFERENCES = /^(internal\.|backup\.(directory|lastBackupAt|lastError))/;

interface StagedImport {
  dir: string;
  manifest: z.infer<typeof ManifestSchema>;
  createdAt: string;
}

export class ExportImportService {
  readonly #config: AppConfig;
  readonly #db: Db;
  readonly #backups: BackupService;
  readonly #bus: EventBus;
  readonly #isBusy: () => boolean;
  readonly #onRestored: () => void;
  readonly #staged = new Map<string, StagedImport>();

  constructor(deps: { config: AppConfig; db: Db; backups: BackupService; bus: EventBus; isBusy: () => boolean; onRestored: () => void }) {
    this.#config = deps.config;
    this.#db = deps.db;
    this.#backups = deps.backups;
    this.#bus = deps.bus;
    this.#isBusy = deps.isBusy;
    this.#onRestored = deps.onRestored;
  }

  exportsDirectory(): string {
    return path.join(this.#backups.directory(), 'Exports');
  }

  #columns(table: TableName): string[] {
    return this.#db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  }

  /** Write a .zip with conversations, folders, memories, assistant settings, preferences, and attachments. No credentials. */
  async export(): Promise<{ path: string; sizeBytes: number; counts: Record<string, number> }> {
    const tables: Record<string, Row[]> = {};
    const counts: Record<string, number> = {};
    for (const table of EXPORT_TABLES) {
      let rows = this.#db.all<Row>(`SELECT * FROM ${table}`);
      if (table === 'preferences') rows = rows.filter((r) => !LOCAL_ONLY_PREFERENCES.test(String(r.key)));
      tables[table] = rows;
      counts[table] = rows.length;
    }
    const data = strToU8(JSON.stringify({ tables }));
    const dataSha256 = createHash('sha256').update(data).digest('hex');
    const attachmentRows = this.#db.all<{ sha256: string; size_bytes: number }>('SELECT sha256, MAX(size_bytes) size_bytes FROM attachments GROUP BY sha256');
    const attachments = attachmentRows
      .filter((r) => existsSync(path.join(this.#config.attachmentsDir, r.sha256.slice(0, 2), r.sha256)))
      .map((r) => ({ sha256: r.sha256, size: r.size_bytes }));
    const manifest = {
      format: 'theologians-export' as const,
      formatVersion: 1 as const,
      createdAt: nowIso(),
      appVersion: this.#config.version,
      schemaVersion: schemaVersion(this.#db),
      includesSecrets: false as const,
      counts,
      dataSha256,
      attachments,
    };

    const dir = this.exportsDirectory();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const finalPath = path.join(dir, `Theologians export ${stamp}.zip`);
    const tmpPath = `${finalPath}.partial`;
    const out = createWriteStream(tmpPath, { mode: 0o600 });
    const finished = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        out.destroy(err);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
    const addFile = (name: string, bytes: Uint8Array, compress: boolean): void => {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    };
    addFile('manifest.json', strToU8(JSON.stringify(manifest, null, 2)), true);
    addFile('data.json', data, true);
    for (const a of attachments) {
      addFile(`attachments/${a.sha256}`, await readFile(path.join(this.#config.attachmentsDir, a.sha256.slice(0, 2), a.sha256)), false);
    }
    zip.end();
    await finished;
    await rename(tmpPath, finalPath);
    return { path: finalPath, sizeBytes: (await stat(finalPath)).size, counts };
  }

  /** Validate an export and stage it. Nothing in the current data changes until apply(). */
  async preview(zipBytes: Uint8Array): Promise<ImportPreviewDto> {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zipBytes);
    } catch {
      throw badRequest("That file isn't a valid Theologians export (.zip).");
    }
    if (!files['manifest.json'] || !files['data.json']) throw badRequest("That file isn't a Theologians export: manifest.json or data.json is missing.");
    let manifest: z.infer<typeof ManifestSchema>;
    try {
      manifest = ManifestSchema.parse(JSON.parse(strFromU8(files['manifest.json'])));
    } catch {
      throw badRequest("This export's manifest is invalid or from an unsupported format.");
    }
    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new AppError('import_too_new', 'This export was made by a newer version of Theologians. Update the app before importing it.', 422);
    }
    if (createHash('sha256').update(files['data.json']).digest('hex') !== manifest.dataSha256) {
      throw new AppError('import_corrupt', "The export's data file doesn't match its checksum, so it may be damaged. Nothing was imported.", 422);
    }
    const data = DataSchema.parse(JSON.parse(strFromU8(files['data.json'])));
    const warnings: string[] = [];
    for (const name of Object.keys(data.tables)) {
      if (!(EXPORT_TABLES as readonly string[]).includes(name)) warnings.push(`Ignoring unknown data “${name}”.`);
    }
    for (const a of manifest.attachments) {
      const bytes = files[`attachments/${a.sha256}`];
      if (!bytes) throw new AppError('import_corrupt', 'An attachment listed in the export is missing. Nothing was imported.', 422);
      if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) {
        throw new AppError('import_corrupt', 'An attachment in the export is damaged. Nothing was imported.', 422);
      }
    }
    const counts: Record<string, number> = {};
    const conflicts: Record<string, number> = {};
    for (const table of EXPORT_TABLES) {
      const rows = data.tables[table] ?? [];
      counts[table] = rows.length;
      const key = PRIMARY_KEYS[table];
      if (key === 'id' && (table === 'attachment_chunks' || table === 'memory_change_ops')) continue;
      let n = 0;
      for (const row of rows) if (this.#db.get(`SELECT 1 FROM ${table} WHERE ${key} = ?`, row[key] as string)) n++;
      if (n) conflicts[table] = n;
    }
    if ((counts.provider_connections ?? 0) > 0) warnings.push('Model connections are imported without API keys or tokens. Add credentials again in Settings → Models.');
    if (manifest.schemaVersion < LATEST_SCHEMA_VERSION) warnings.push('This export comes from an older version and will be upgraded as it is imported.');

    const token = newId();
    const dir = path.join(this.#config.dataDir, 'imports', token);
    await mkdir(path.join(dir, 'attachments'), { recursive: true });
    await writeFile(path.join(dir, 'data.json'), files['data.json']);
    for (const a of manifest.attachments) await writeFile(path.join(dir, 'attachments', a.sha256), files[`attachments/${a.sha256}`]!);
    this.#staged.set(token, { dir, manifest, createdAt: nowIso() });
    return { token, createdAt: manifest.createdAt, appVersion: manifest.appVersion, schemaVersion: manifest.schemaVersion, counts, conflicts, warnings };
  }

  async discard(token: string): Promise<void> {
    const staged = this.#staged.get(token);
    if (!staged) return;
    this.#staged.delete(token);
    await rm(staged.dir, { recursive: true, force: true });
  }

  /**
   * merge: add everything that doesn't already exist; existing records are never overwritten.
   * replace: make the current data exactly match the export.
   * Either way a safety backup is made first, and the whole import is one transaction.
   */
  async apply(token: string, mode: 'merge' | 'replace'): Promise<{ imported: Record<string, number>; skipped: Record<string, number> }> {
    const staged = this.#staged.get(token);
    if (!staged) throw notFound('Staged import (preview it again)');
    if (this.#isBusy()) throw conflict('Stop any responses that are still running before importing.');
    const data = DataSchema.parse(JSON.parse(await readFile(path.join(staged.dir, 'data.json'), 'utf8')));
    await this.#backups.create('before_import');

    const imported: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const idMap = { sections: new Map<string, string>(), workspaces: new Map<string, string>(), profiles: new Map<string, string>() };
    const skippedIds = { changes: new Set<string>(), attachments: new Set<string>() };
    const remap = (map: Map<string, string>, value: unknown): unknown => (typeof value === 'string' && map.has(value) ? map.get(value) : value);

    this.#db.tx(() => {
      if (mode === 'replace') {
        this.#db.run('DELETE FROM tool_approvals');
        for (const table of [...EXPORT_TABLES].reverse()) {
          if (table === 'preferences') this.#db.run("DELETE FROM preferences WHERE key NOT LIKE 'internal.%' AND key NOT LIKE 'backup.%'");
          else this.#db.run(`DELETE FROM ${table}`);
        }
      }
      for (const table of EXPORT_TABLES) {
        const columns = new Set(this.#columns(table));
        imported[table] = 0;
        skipped[table] = 0;
        for (const original of data.tables[table] ?? []) {
          const row: Row = { ...original };
          if (mode === 'merge') {
            if (table === 'sections') {
              const local = this.#db.get<{ id: string }>('SELECT id FROM sections WHERE slug = ?', row.slug as string);
              if (local) {
                idMap.sections.set(row.id as string, local.id);
                skipped[table]++;
                continue;
              }
            }
            if (table === 'workspaces') {
              row.section_id = remap(idMap.sections, row.section_id);
              const local = this.#db.get<{ id: string }>('SELECT id FROM workspaces WHERE slug = ?', row.slug as string);
              if (local) {
                idMap.workspaces.set(row.id as string, local.id);
                skipped[table]++;
                continue;
              }
            }
            if (table === 'assistant_profiles') {
              row.workspace_id = remap(idMap.workspaces, row.workspace_id);
              if (row.default_key) {
                const local = this.#db.get<{ id: string }>('SELECT id FROM assistant_profiles WHERE default_key = ?', row.default_key as string);
                if (local) {
                  idMap.profiles.set(row.id as string, local.id);
                  skipped[table]++;
                  continue;
                }
              }
            }
            for (const col of ['workspace_id']) if (col in row) row[col] = remap(idMap.workspaces, row[col]);
            if ('selected_profile_id' in row) row.selected_profile_id = remap(idMap.profiles, row.selected_profile_id);
            if ('profile_id' in row) row.profile_id = remap(idMap.profiles, row.profile_id);
            if (table === 'memory_change_ops' || table === 'attachment_chunks') {
              const parent = table === 'memory_change_ops' ? (row.change_id as string) : (row.attachment_id as string);
              if ((table === 'memory_change_ops' ? skippedIds.changes : skippedIds.attachments).has(parent)) {
                skipped[table]++;
                continue;
              }
              delete row.id;
            } else {
              const key = PRIMARY_KEYS[table];
              if (this.#db.get(`SELECT 1 FROM ${table} WHERE ${key} = ?`, row[key] as string)) {
                if (table === 'memory_changes') skippedIds.changes.add(row.id as string);
                if (table === 'attachments') skippedIds.attachments.add(row.id as string);
                skipped[table]++;
                continue;
              }
            }
          }
          // Keep references valid when their targets aren't present.
          if (table === 'conversations') {
            if (row.selected_model_id && !this.#db.get('SELECT 1 FROM models WHERE id = ?', row.selected_model_id as string)) row.selected_model_id = null;
            if (row.folder_id && !this.#db.get('SELECT 1 FROM folders WHERE id = ?', row.folder_id as string)) row.folder_id = null;
            if (row.selected_profile_id && !this.#db.get('SELECT 1 FROM assistant_profiles WHERE id = ?', row.selected_profile_id as string)) row.selected_profile_id = null;
          }
          if (table === 'assistant_profiles' && row.preferred_model_id && !this.#db.get('SELECT 1 FROM models WHERE id = ?', row.preferred_model_id as string)) {
            row.preferred_model_id = null;
          }
          if (table === 'provider_connections') {
            row.status = row.auth_type === 'api_key' || row.auth_type === 'bearer_token' ? 'needs_credentials' : 'unverified';
            row.status_detail = 'Imported — add credentials and test the connection.';
          }
          const cols = Object.keys(row).filter((c) => columns.has(c));
          const values = cols.map((c) => {
            const v = row[c];
            return v === null || typeof v === 'string' || typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : JSON.stringify(v);
          });
          try {
            this.#db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...values);
          } catch (err) {
            throw new AppError('import_invalid', `The export contains invalid ${table.replace(/_/g, ' ')} data (${err instanceof Error ? err.message : err}). Nothing was imported.`, 422);
          }
          imported[table]++;
        }
      }
      seedDefaults(this.#db);
    });

    for (const a of staged.manifest.attachments) {
      const target = path.join(this.#config.attachmentsDir, a.sha256.slice(0, 2), a.sha256);
      if (!existsSync(target)) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(staged.dir, 'attachments', a.sha256), target);
      }
    }
    await this.discard(token);
    this.#onRestored();
    this.#bus.publish({ type: 'data.restored' });
    return { imported, skipped };
  }
}
