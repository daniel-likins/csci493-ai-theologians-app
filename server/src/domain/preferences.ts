import type { Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { nowIso } from '../lib/ids.ts';

/** Small JSON key/value store for preferences shared by every view (theme, panel layout, drafts…). */
export class PreferencesService {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  get<T>(key: string, fallback: T): T {
    const row = this.#db.get<{ value_json: string }>('SELECT value_json FROM preferences WHERE key = ?', key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  /** All preferences except per-conversation drafts, which are loaded on demand. */
  getAll(): Record<string, unknown> {
    const rows = this.#db.all<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM preferences WHERE key NOT LIKE 'draft.%' AND key NOT LIKE 'internal.%'",
    );
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value_json);
      } catch {
        // ignore corrupt values; callers fall back to defaults
      }
    }
    return out;
  }

  set(key: string, value: unknown, originClientId?: string, notify = true): void {
    this.#db.run(
      `INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      nowIso(),
    );
    if (notify) this.#bus.publish({ type: 'preferences.changed', keys: [key] }, originClientId);
  }

  delete(key: string): void {
    this.#db.run('DELETE FROM preferences WHERE key = ?', key);
  }
}
