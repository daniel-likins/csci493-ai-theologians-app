import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array;
type BoundValue = string | number | bigint | null | Uint8Array;

function bind(value: SqlParam): BoundValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Thin synchronous wrapper around node:sqlite.
 * - WAL + synchronous=FULL: durable commits, concurrent readers.
 * - Statement cache.
 * - Nested transactions via savepoints. Transaction callbacks must be synchronous.
 */
export class Db {
  readonly file: string;
  #raw: DatabaseSync;
  #cache = new Map<string, StatementSync>();
  #depth = 0;

  constructor(file: string) {
    this.file = file;
    this.#raw = Db.#open(file);
  }

  static #open(file: string): DatabaseSync {
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = FULL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
    return raw;
  }

  get raw(): DatabaseSync {
    return this.#raw;
  }

  /**
   * Replace the database file with a copy of another SQLite file and reopen it in place, so every
   * service keeps working with the restored data. Used only by restore.
   */
  replaceWithFile(source: string): void {
    if (this.#depth > 0) throw new Error('Cannot replace the database during a transaction');
    this.#cache.clear();
    this.#raw.close();
    const tmp = `${this.file}.restoring`;
    copyFileSync(source, tmp);
    rmSync(`${this.file}-wal`, { force: true });
    rmSync(`${this.file}-shm`, { force: true });
    renameSync(tmp, this.file);
    this.#raw = Db.#open(this.file);
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.#stmt(sql).get(...params.map(bind)) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.#stmt(sql).all(...params.map(bind)) as T[];
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.#stmt(sql).run(...params.map(bind));
    return { changes: Number(result.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  tx<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const savepoint = `sp_${this.#depth}`;
    this.raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error('Db.tx callbacks must be synchronous');
      }
      this.raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      if (nested) {
        this.raw.exec(`ROLLBACK TO ${savepoint}`);
        this.raw.exec(`RELEASE ${savepoint}`);
      } else {
        this.raw.exec('ROLLBACK');
      }
      throw err;
    } finally {
      this.#depth--;
    }
  }

  close(): void {
    this.#cache.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
