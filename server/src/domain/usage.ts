import type { UsageSummaryDto } from '../../../shared/types.ts';
import { toBool, type Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { nowIso } from '../lib/ids.ts';

export type UsagePurpose = 'chat' | 'memory_suggestions' | 'summary' | 'checkin' | 'connection_test' | 'web_search';

export interface UsageRecord {
  purpose: UsagePurpose;
  workspaceId?: string | null;
  conversationId?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimated?: boolean;
  status: 'ok' | 'error' | 'cancelled';
  detail?: string | null;
}

/** Transparent log of every model call and paid search the app makes on the user's behalf. */
export class UsageService {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  record(entry: UsageRecord): void {
    this.#db.run(
      `INSERT INTO usage_events (created_at, purpose, workspace_id, conversation_id, model_id, model_label, input_tokens, output_tokens,
         estimated, status, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      entry.purpose,
      entry.workspaceId ?? null,
      entry.conversationId ?? null,
      entry.modelId ?? null,
      entry.modelLabel ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.estimated ?? false,
      entry.status,
      entry.detail ?? null,
    );
    this.#bus.publish({ type: 'usage.changed' });
  }

  countSince(purpose: UsagePurpose, sinceIso: string, workspaceId?: string): number {
    return (
      this.#db.get<{ n: number }>(
        `SELECT COUNT(*) n FROM usage_events WHERE purpose = ? AND created_at >= ? ${workspaceId ? 'AND workspace_id = ?' : ''}`,
        purpose,
        sinceIso,
        ...(workspaceId ? [workspaceId] : []),
      )?.n ?? 0
    );
  }

  summary(days = 30): UsageSummaryDto {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.#db.all<{ purpose: string; calls: number; input: number | null; output: number | null; estimated: number }>(
      `SELECT purpose, COUNT(*) calls, SUM(COALESCE(input_tokens, 0)) input, SUM(COALESCE(output_tokens, 0)) output, MAX(estimated) estimated
       FROM usage_events WHERE created_at >= ? GROUP BY purpose ORDER BY calls DESC`,
      since,
    );
    const recent = this.#db.all<{
      created_at: string;
      purpose: string;
      model_label: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      estimated: number;
      status: string;
      detail: string | null;
    }>('SELECT * FROM usage_events ORDER BY id DESC LIMIT 50');
    return {
      since,
      rows: rows.map((r) => ({
        purpose: r.purpose,
        calls: r.calls,
        inputTokens: r.input ?? 0,
        outputTokens: r.output ?? 0,
        estimated: toBool(r.estimated),
      })),
      recent: recent.map((r) => ({
        createdAt: r.created_at,
        purpose: r.purpose,
        modelLabel: r.model_label,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        estimated: toBool(r.estimated),
        status: r.status,
        detail: r.detail,
      })),
    };
  }
}
