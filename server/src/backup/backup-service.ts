import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { access, constants, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupEntryDto, BackupSettingsDto } from '../../../shared/types.ts';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { LATEST_SCHEMA_VERSION, runMigrations, schemaVersion } from '../db/migrations.ts';
import { seedDefaults } from '../db/seed.ts';
import type { PreferencesService } from '../domain/preferences.ts';
import type { EventBus } from '../events/bus.ts';
import { AppError, badRequest, conflict, errorMessage, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';

export type BackupReason = BackupEntryDto['reason'];

interface BackupManifest {
  format: 'theologians-backup';
  formatVersion: 1;
  id: string;
  createdAt: string;
  reason: BackupReason;
  appVersion: string;
  schemaVersion: number;
  dbSha256: string;
  dbSizeBytes: number;
  attachments: string[];
}

export const RETENTION_DESCRIPTION =
  'Keeps the newest automatic backup for each of the last 7 days, 4 weeks, and 6 months; the 10 most recent manual backups; and the 5 most recent safety backups made before a restore, import, or upgrade.';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

/** Decide which backups to keep. Pure, so the retention policy is easy to test. */
export function selectRetained(entries: { id: string; createdAt: string; reason: BackupReason }[]): Set<string> {
  const keep = new Set<string>();
  const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const automatic = sorted.filter((e) => e.reason === 'automatic');
  const bucket = (key: (d: Date) => string, count: number): void => {
    const seen = new Set<string>();
    for (const e of automatic) {
      const k = key(new Date(e.createdAt));
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > count) break;
      keep.add(e.id);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), 7);
  bucket(isoWeek, 4);
  bucket((d) => d.toISOString().slice(0, 7), 6);
  sorted.filter((e) => e.reason === 'manual').slice(0, 10).forEach((e) => keep.add(e.id));
  sorted.filter((e) => e.reason.startsWith('before_')).slice(0, 5).forEach((e) => keep.add(e.id));
  return keep;
}

/**
 * Automatic and manual local backups. A backup is a consistent SQLite snapshot (VACUUM INTO) plus the
 * attachment files it references, stored content-addressed so unchanged files are copied only once.
 */
export class BackupService {
  readonly #config: AppConfig;
  readonly #db: Db;
  readonly #prefs: PreferencesService;
  readonly #bus: EventBus;
  readonly #isBusy: () => boolean;
  readonly #onRestored: () => void;
  #timer: NodeJS.Timeout | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: { config: AppConfig; db: Db; prefs: PreferencesService; bus: EventBus; isBusy: () => boolean; onRestored: () => void }) {
    this.#config = deps.config;
    this.#db = deps.db;
    this.#prefs = deps.prefs;
    this.#bus = deps.bus;
    this.#isBusy = deps.isBusy;
    this.#onRestored = deps.onRestored;
  }

  directory(): string {
    return this.#prefs.get<string | null>('backup.directory', null) ?? this.#config.defaultBackupDir;
  }

  settings(): BackupSettingsDto {
    const directory = this.directory();
    return {
      directory,
      isDefaultDirectory: directory === this.#config.defaultBackupDir,
      automatic: this.#prefs.get<boolean>('backup.automatic', true),
      lastBackupAt: this.#prefs.get<string | null>('backup.lastBackupAt', null),
      lastBackupError: this.#prefs.get<string | null>('backup.lastError', null),
      retention: RETENTION_DESCRIPTION,
    };
  }

  async setDirectory(directory: string | null): Promise<BackupSettingsDto> {
    if (directory === null) {
      this.#prefs.set('backup.directory', null);
    } else {
      if (!path.isAbsolute(directory)) throw badRequest('Choose the backup folder using its full path.');
      const resolved = path.resolve(directory);
      if (resolved === this.#config.dataDir || resolved.startsWith(this.#config.attachmentsDir)) {
        throw badRequest("Choose a folder outside Theologians' own data folder.");
      }
      try {
        await mkdir(resolved, { recursive: true });
        await access(resolved, constants.W_OK);
      } catch {
        throw badRequest("Theologians can't write to that folder.");
      }
      this.#prefs.set('backup.directory', resolved);
    }
    this.#bus.publish({ type: 'settings.changed', area: 'backup' });
    return this.settings();
  }

  setAutomatic(enabled: boolean): BackupSettingsDto {
    this.#prefs.set('backup.automatic', enabled);
    this.#bus.publish({ type: 'settings.changed', area: 'backup' });
    return this.settings();
  }

  async #readManifest(dir: string): Promise<BackupManifest | null> {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
      return manifest.format === 'theologians-backup' ? manifest : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<BackupEntryDto[]> {
    const snapshots = path.join(this.directory(), 'snapshots');
    if (!existsSync(snapshots)) return [];
    const out: BackupEntryDto[] = [];
    for (const name of await readdir(snapshots)) {
      if (name.startsWith('.')) continue;
      const manifest = await this.#readManifest(path.join(snapshots, name));
      if (!manifest) continue;
      out.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        sizeBytes: manifest.dbSizeBytes,
        schemaVersion: manifest.schemaVersion,
        attachmentCount: manifest.attachments.length,
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(reason: BackupReason): Promise<BackupEntryDto> {
    const run = this.#queue.then(() => this.#create(reason));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #create(reason: BackupReason): Promise<BackupEntryDto> {
    const root = this.directory();
    const snapshots = path.join(root, 'snapshots');
    const store = path.join(root, 'attachments');
    const createdAt = nowIso();
    const id = `${createdAt.replace(/[:.]/g, '-')}_${reason}`;
    const partial = path.join(snapshots, `.${id}.partial`);
    try {
      await mkdir(partial, { recursive: true });
      const dbCopy = path.join(partial, 'theologians.db');
      this.#db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
      const hashes = this.#db.all<{ sha256: string }>('SELECT DISTINCT sha256 FROM attachments').map((r) => r.sha256);
      for (const hash of hashes) {
        const source = path.join(this.#config.attachmentsDir, hash.slice(0, 2), hash);
        const target = path.join(store, hash.slice(0, 2), hash);
        if (!existsSync(target) && existsSync(source)) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(source, `${target}.tmp`);
          await rename(`${target}.tmp`, target);
        }
      }
      const manifest: BackupManifest = {
        format: 'theologians-backup',
        formatVersion: 1,
        id,
        createdAt,
        reason,
        appVersion: this.#config.version,
        schemaVersion: schemaVersion(this.#db),
        dbSha256: await sha256File(dbCopy),
        dbSizeBytes: (await stat(dbCopy)).size,
        attachments: hashes,
      };
      await writeFile(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await rename(partial, path.join(snapshots, id));
      if (reason === 'automatic' || reason === 'manual') {
        this.#prefs.set('backup.lastBackupAt', createdAt, undefined, false);
        this.#prefs.set('backup.lastError', null, undefined, false);
      }
      await this.prune();
      this.#bus.publish({ type: 'settings.changed', area: 'backup' });
      return {
        id,
        createdAt,
        reason,
        sizeBytes: manifest.dbSizeBytes,
        schemaVersion: manifest.schemaVersion,
        attachmentCount: hashes.length,
      };
    } catch (err) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      const message = `Backup failed: ${errorMessage(err)}`;
      this.#prefs.set('backup.lastError', message, undefined, false);
      this.#bus.publish({ type: 'settings.changed', area: 'backup' });
      throw new AppError('backup_failed', message, 500);
    }
  }

  async prune(): Promise<number> {
    const root = this.directory();
    const entries = await this.list();
    const keep = selectRetained(entries);
    let removed = 0;
    for (const entry of entries) {
      if (!keep.has(entry.id)) {
        await rm(path.join(root, 'snapshots', entry.id), { recursive: true, force: true });
        removed++;
      }
    }
    // Remove stored attachment files no remaining backup references.
    const referenced = new Set<string>();
    for (const entry of entries.filter((e) => keep.has(e.id))) {
      const manifest = await this.#readManifest(path.join(root, 'snapshots', entry.id));
      manifest?.attachments.forEach((h) => referenced.add(h));
    }
    const store = path.join(root, 'attachments');
    if (existsSync(store)) {
      for (const prefix of await readdir(store)) {
        for (const file of await readdir(path.join(store, prefix)).catch(() => [] as string[])) {
          if (/^[0-9a-f]{64}$/.test(file) && !referenced.has(file)) await rm(path.join(store, prefix, file), { force: true });
        }
      }
    }
    return removed;
  }

  async restore(id: string): Promise<{ missingAttachments: number }> {
    if (this.#isBusy()) throw conflict('Stop any responses that are still running before restoring a backup.');
    if (!/^[\w-]+$/.test(id)) throw badRequest('Invalid backup id.');
    const root = this.directory();
    const dir = path.join(root, 'snapshots', id);
    const manifest = await this.#readManifest(dir);
    if (!manifest) throw notFound('Backup');
    const dbFile = path.join(dir, 'theologians.db');
    if (!existsSync(dbFile) || (await sha256File(dbFile)) !== manifest.dbSha256) {
      throw new AppError('backup_corrupt', "This backup's database file is missing or damaged, so it can't be restored.", 422);
    }
    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new AppError('backup_too_new', 'This backup was made by a newer version of Theologians. Update the app before restoring it.', 422);
    }
    const missing = manifest.attachments.filter(
      (h) => !existsSync(path.join(root, 'attachments', h.slice(0, 2), h)) && !existsSync(path.join(this.#config.attachmentsDir, h.slice(0, 2), h)),
    );

    await this.create('before_restore');
    this.#db.replaceWithFile(dbFile);
    runMigrations(this.#db);
    seedDefaults(this.#db);
    for (const hash of manifest.attachments) {
      const target = path.join(this.#config.attachmentsDir, hash.slice(0, 2), hash);
      const source = path.join(root, 'attachments', hash.slice(0, 2), hash);
      if (!existsSync(target) && existsSync(source)) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    }
    this.#onRestored();
    this.#bus.publish({ type: 'data.restored' });
    return { missingAttachments: missing.length };
  }

  hasUserData(): boolean {
    return (
      (this.#db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM memory_items) AS n')?.n ?? 0) > 0
    );
  }

  start(): void {
    const check = (): void => {
      const s = this.settings();
      if (!s.automatic || !this.hasUserData()) return;
      if (s.lastBackupAt && Date.now() - new Date(s.lastBackupAt).getTime() < 23 * 3_600_000) return;
      void this.create('automatic').catch(() => undefined);
    };
    setTimeout(check, 30_000).unref();
    this.#timer = setInterval(check, 3_600_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
