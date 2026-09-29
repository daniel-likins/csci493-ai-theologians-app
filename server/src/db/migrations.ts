import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';
import type { Db } from './database.ts';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .map((file) => /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ version: Number(m[1]), name: m[2]!, file: path.join(dir, m[0]) }))
    .sort((a, b) => a.version - b.version);
}

export const LATEST_SCHEMA_VERSION = listMigrations().at(-1)?.version ?? 0;

function ensureTable(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
}

export function schemaVersion(db: Db): number {
  ensureTable(db);
  return db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
}

export function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): MigrationFile[] {
  const current = schemaVersion(db);
  return listMigrations(dir).filter((m) => m.version > current);
}

/**
 * Apply pending migrations, each in its own transaction. Refuses to open a database written by a
 * newer app version, so an older build can never silently damage newer data.
 */
export function runMigrations(db: Db, dir = MIGRATIONS_DIR): { applied: number[]; version: number } {
  const migrations = listMigrations(dir);
  const latest = migrations.at(-1)?.version ?? 0;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new AppError(
      'database_too_new',
      `This database uses schema version ${current}, but this build of Theologians only knows up to ${latest}. Update the app instead of opening newer data with an older build.`,
      500,
    );
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const sql = readFileSync(migration.file, 'utf8');
    db.tx(() => {
      db.exec(sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        nowIso(),
      );
    });
    applied.push(migration.version);
  }
  return { applied, version: schemaVersion(db) };
}
