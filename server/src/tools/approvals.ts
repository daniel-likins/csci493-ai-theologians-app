import type { ApprovalKind, ApprovalStatus, ToolApprovalDto } from '../../../shared/types.ts';
import { parseJson, type Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';

interface ApprovalRow {
  id: string;
  conversation_id: string;
  message_id: string;
  tool_call_id: string;
  kind: ApprovalKind;
  payload_json: string;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
}

function toDto(row: ApprovalRow): ToolApprovalDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** Explicit user approval for commands, file edits, and reads outside the working folder. */
export class ApprovalService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #waiters = new Map<string, (decision: 'approved' | 'denied') => void>();

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  get(id: string): ToolApprovalDto {
    const row = this.#db.get<ApprovalRow>('SELECT * FROM tool_approvals WHERE id = ?', id);
    if (!row) throw notFound('Approval request');
    return toDto(row);
  }

  list(conversationId: string): ToolApprovalDto[] {
    return this.#db.all<ApprovalRow>('SELECT * FROM tool_approvals WHERE conversation_id = ? ORDER BY created_at', conversationId).map(toDto);
  }

  async request(
    input: { conversationId: string; messageId: string; toolCallId: string; kind: ApprovalKind; payload: Record<string, unknown> },
    signal: AbortSignal,
    onCreated: (approvalId: string) => void,
    timeoutMs = 15 * 60_000,
  ): Promise<ApprovalStatus> {
    const id = newId();
    this.#db.run(
      `INSERT INTO tool_approvals (id, conversation_id, message_id, tool_call_id, kind, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      input.conversationId,
      input.messageId,
      input.toolCallId,
      input.kind,
      JSON.stringify(input.payload),
      nowIso(),
    );
    onCreated(id);
    this.#bus.publish({ type: 'approvals.changed', conversationId: input.conversationId });

    const decision = await new Promise<ApprovalStatus>((resolve) => {
      let settled = false;
      const finish = (status: ApprovalStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#waiters.delete(id);
        resolve(status);
      };
      const onAbort = (): void => finish('cancelled');
      const timer = setTimeout(() => finish('expired'), timeoutMs);
      if (signal.aborted) finish('cancelled');
      else signal.addEventListener('abort', onAbort, { once: true });
      this.#waiters.set(id, finish);
    });

    this.#db.run("UPDATE tool_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", decision, nowIso(), id);
    this.#bus.publish({ type: 'approvals.changed', conversationId: input.conversationId });
    return this.get(id).status;
  }

  decide(id: string, decision: 'approved' | 'denied'): ToolApprovalDto {
    const approval = this.get(id);
    if (approval.status !== 'pending') throw conflict('This request was already answered.');
    const waiter = this.#waiters.get(id);
    if (!waiter) {
      this.#db.run("UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE id = ?", nowIso(), id);
      this.#bus.publish({ type: 'approvals.changed', conversationId: approval.conversationId });
      throw conflict('This request is no longer waiting — the response ended or the app restarted. Nothing was run.');
    }
    this.#db.run('UPDATE tool_approvals SET status = ?, decided_at = ? WHERE id = ?', decision, nowIso(), id);
    waiter(decision);
    return this.get(id);
  }

  /** On startup nothing can still be waiting, so leftover requests expire (nothing runs). */
  expireOrphans(): number {
    return this.#db.run("UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'", nowIso()).changes;
  }
}
