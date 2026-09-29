import { categorySingular, MEMORY_CATEGORY_IDS, MEMORY_CERTAINTY_IDS } from '../../../shared/constants.ts';
import type {
  MemoryCategory,
  MemoryCertainty,
  MemoryChangeDto,
  MemoryItemDto,
  MemoryOrigin,
  MemoryProposalDto,
  MemorySnapshot,
  ProposalStatus,
  WorkspaceDto,
} from '../../../shared/types.ts';
import type { Db } from '../db/database.ts';
import type { WorkspaceService } from '../domain/workspaces.ts';
import type { EventBus } from '../events/bus.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { normalizeText, similarity, tokenSet } from '../lib/text.ts';

/**
 * Who is asking to change memory. Authorization is derived from stored data (profile kind, conversation
 * workspace), never from what a caller claims.
 */
export type MemoryActor =
  | { kind: 'user' }
  | { kind: 'goals_assistant'; profileId: string; conversationId: string }
  | { kind: 'suggestion_scan'; conversationId: string }
  | { kind: 'master_assistant'; conversationId?: string }
  | { kind: 'import' };

export const MASTER_WRITE_DENIED =
  'The master Goals assistant is advisory only. It cannot change any mission’s goals, memory, plans, or progress — open the mission to make changes there.';

export interface ProposalInput {
  op: 'add' | 'update' | 'remove';
  targetItemId?: string | null;
  category?: MemoryCategory | null;
  certainty?: MemoryCertainty | null;
  text?: string | null;
  reason?: string | null;
  evidence?: string | null;
  importance?: 'low' | 'medium' | 'high' | null;
  sourceMessageId?: string | null;
}

export interface MissionMemoryView {
  workspace: WorkspaceDto;
  items: MemoryItemDto[];
  lastChangedAt: string | null;
  pendingCount: number;
}

interface ItemRow {
  id: string;
  workspace_id: string;
  category: MemoryCategory;
  certainty: MemoryCertainty;
  text: string;
  origin: MemoryOrigin;
  source_conversation_id: string | null;
  source_title: string | null;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ProposalRow {
  id: string;
  workspace_id: string;
  op: 'add' | 'update' | 'remove';
  target_item_id: string | null;
  category: MemoryCategory | null;
  certainty: MemoryCertainty | null;
  text: string | null;
  reason: string;
  evidence: string | null;
  importance: 'low' | 'medium' | 'high';
  source_kind: 'suggestion_scan' | 'goals_assistant';
  source_conversation_id: string | null;
  source_title: string | null;
  source_message_id: string | null;
  status: ProposalStatus;
  status_detail: string | null;
  change_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface ChangeRow {
  id: string;
  workspace_id: string;
  origin: MemoryChangeDto['origin'];
  summary: string;
  proposal_id: string | null;
  undo_of_change_id: string | null;
  undone_by_change_id: string | null;
  created_at: string;
}

type Snapshot = MemorySnapshot & { version: number };

interface OpRecord {
  itemId: string;
  op: 'add' | 'update' | 'remove';
  before: Snapshot | null;
  after: Snapshot | null;
}

const CATEGORY_ORDER = new Map(MEMORY_CATEGORY_IDS.map((id, i) => [id, i]));
const MAX_TEXT = 400;
const DUPLICATE_THRESHOLD = 0.85;
const REVISION_THRESHOLD = 0.6;

function cleanText(text: string | null | undefined, field = 'text'): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw badRequest(`Memory ${field} can't be empty.`);
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

function assertCategory(value: unknown): MemoryCategory {
  if (!MEMORY_CATEGORY_IDS.includes(value as MemoryCategory)) throw badRequest('Unknown memory category.');
  return value as MemoryCategory;
}

function assertCertainty(value: unknown): MemoryCertainty {
  if (!MEMORY_CERTAINTY_IDS.includes(value as MemoryCertainty)) throw badRequest('Unknown certainty.');
  return value as MemoryCertainty;
}

function toItem(row: ItemRow): MemoryItemDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    certainty: row.certainty,
    text: row.text,
    origin: row.origin,
    sourceConversationId: row.source_conversation_id,
    sourceTitle: row.source_title,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotOf(row: ItemRow): Snapshot {
  return { category: row.category, certainty: row.certainty, text: row.text, deleted: row.deleted_at !== null, version: row.version };
}

function quote(text: string): string {
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
}

/** Fraction of the evidence's meaningful words found in the message. */
function coverage(evidence: string, message: string): number {
  const need = tokenSet(evidence);
  if (need.size === 0) return 0;
  const have = tokenSet(message);
  let hit = 0;
  for (const w of need) if (have.has(w)) hit++;
  return hit / need.size;
}

export class MemoryService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #workspaces: WorkspaceService;

  constructor(db: Db, bus: EventBus, workspaces: WorkspaceService) {
    this.#db = db;
    this.#bus = bus;
    this.#workspaces = workspaces;
  }

  // ── Authorization ──────────────────────────────────────────────────────────
  #goalsWorkspace(workspaceId: string): WorkspaceDto {
    const ws = this.#workspaces.get(workspaceId);
    if (!ws.hasGoals) throw forbidden('This workspace has no Goals memory.');
    return ws;
  }

  /** Direct edits: only the user (through the mission UI) or an import. Assistants must use proposals. */
  #assertDirectEditor(actor: MemoryActor): void {
    if (actor.kind === 'master_assistant') throw forbidden(MASTER_WRITE_DENIED);
    if (actor.kind !== 'user' && actor.kind !== 'import') {
      throw forbidden('Assistants can only suggest memory changes; you decide whether to apply them.');
    }
  }

  /** Proposals: only this mission's Goals assistant or the suggestion scanner, from a conversation in this mission. */
  #assertProposer(actor: MemoryActor, workspaceId: string): { conversationId: string; title: string } {
    if (actor.kind === 'master_assistant') throw forbidden(MASTER_WRITE_DENIED);
    if (actor.kind !== 'goals_assistant' && actor.kind !== 'suggestion_scan') {
      throw forbidden('Only Goals assistants and memory suggestions create proposals.');
    }
    if (actor.kind === 'goals_assistant') {
      const profile = this.#db.get<{ kind: string; workspace_id: string | null }>(
        'SELECT kind, workspace_id FROM assistant_profiles WHERE id = ?',
        actor.profileId,
      );
      if (!profile || profile.kind !== 'goals' || profile.workspace_id !== workspaceId) {
        throw forbidden('Only this mission’s Goals assistant can suggest changes to its memory.');
      }
    }
    const conversation = this.#db.get<{ workspace_id: string | null; kind: string; title: string }>(
      'SELECT workspace_id, kind, title FROM conversations WHERE id = ?',
      actor.conversationId,
    );
    if (!conversation) throw notFound('Source conversation');
    if (conversation.kind === 'master' || conversation.workspace_id === null) throw forbidden(MASTER_WRITE_DENIED);
    if (conversation.workspace_id !== workspaceId) {
      throw forbidden('Memory suggestions can only come from conversations in the same mission.');
    }
    return { conversationId: actor.conversationId, title: conversation.title };
  }

  // ── Items ──────────────────────────────────────────────────────────────────
  listItems(workspaceId: string): MemoryItemDto[] {
    return this.#db
      .all<ItemRow>('SELECT * FROM memory_items WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId)
      .sort(
        (a, b) =>
          (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99) ||
          a.sort_order - b.sort_order ||
          a.created_at.localeCompare(b.created_at),
      )
      .map(toItem);
  }

  #itemRow(id: string): ItemRow {
    const row = this.#db.get<ItemRow>('SELECT * FROM memory_items WHERE id = ?', id);
    if (!row) throw notFound('Memory item');
    return row;
  }

  view(workspaceId: string): MissionMemoryView {
    const workspace = this.#goalsWorkspace(workspaceId);
    const last = this.#db.get<{ at: string | null }>('SELECT MAX(created_at) at FROM memory_changes WHERE workspace_id = ?', workspaceId);
    const pending = this.#db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM memory_proposals WHERE workspace_id = ? AND status = 'pending'",
      workspaceId,
    );
    return { workspace, items: this.listItems(workspaceId), lastChangedAt: last?.at ?? null, pendingCount: pending?.n ?? 0 };
  }

  #recordChange(
    workspaceId: string,
    origin: MemoryChangeDto['origin'],
    summary: string,
    ops: OpRecord[],
    links: { proposalId?: string | null; undoOfChangeId?: string | null } = {},
  ): string {
    const id = newId();
    this.#db.run(
      `INSERT INTO memory_changes (id, workspace_id, origin, summary, proposal_id, undo_of_change_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      origin,
      summary,
      links.proposalId ?? null,
      links.undoOfChangeId ?? null,
      nowIso(),
    );
    for (const op of ops) {
      this.#db.run(
        'INSERT INTO memory_change_ops (change_id, item_id, op, before_json, after_json) VALUES (?, ?, ?, ?, ?)',
        id,
        op.itemId,
        op.op,
        op.before ? JSON.stringify(op.before) : null,
        op.after ? JSON.stringify(op.after) : null,
      );
    }
    return id;
  }

  #insertItem(
    workspaceId: string,
    fields: { category: MemoryCategory; certainty: MemoryCertainty; text: string; origin: MemoryOrigin; sourceConversationId?: string | null; sourceTitle?: string | null },
  ): OpRecord {
    const id = newId();
    const now = nowIso();
    const order = (this.#db.get<{ n: number | null }>('SELECT MAX(sort_order) n FROM memory_items WHERE workspace_id = ?', workspaceId)?.n ?? -1) + 1;
    this.#db.run(
      `INSERT INTO memory_items (id, workspace_id, category, certainty, text, origin, source_conversation_id, source_title, sort_order,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      workspaceId,
      fields.category,
      fields.certainty,
      fields.text,
      fields.origin,
      fields.sourceConversationId ?? null,
      fields.sourceTitle ?? null,
      order,
      now,
      now,
    );
    return { itemId: id, op: 'add', before: null, after: snapshotOf(this.#itemRow(id)) };
  }

  #updateItem(row: ItemRow, patch: { category?: MemoryCategory; certainty?: MemoryCertainty; text?: string }): OpRecord {
    const before = snapshotOf(row);
    this.#db.run(
      'UPDATE memory_items SET category = ?, certainty = ?, text = ?, version = version + 1, updated_at = ? WHERE id = ?',
      patch.category ?? row.category,
      patch.certainty ?? row.certainty,
      patch.text ?? row.text,
      nowIso(),
      row.id,
    );
    return { itemId: row.id, op: 'update', before, after: snapshotOf(this.#itemRow(row.id)) };
  }

  #removeItem(row: ItemRow): OpRecord {
    const before = snapshotOf(row);
    this.#db.run('UPDATE memory_items SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', nowIso(), nowIso(), row.id);
    return { itemId: row.id, op: 'remove', before, after: null };
  }

  #liveDuplicate(workspaceId: string, text: string, exceptId?: string): ItemRow | null {
    let best: ItemRow | null = null;
    let bestScore = 0;
    for (const row of this.#db.all<ItemRow>('SELECT * FROM memory_items WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId)) {
      if (row.id === exceptId) continue;
      const score = normalizeText(row.text) === normalizeText(text) ? 1 : similarity(row.text, text);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    return best && bestScore >= 0.92 ? best : null;
  }

  addItem(actor: MemoryActor, workspaceId: string, input: { category: MemoryCategory; certainty: MemoryCertainty; text: string }): MemoryItemDto {
    this.#assertDirectEditor(actor);
    this.#goalsWorkspace(workspaceId);
    const category = assertCategory(input.category);
    const certainty = assertCertainty(input.certainty);
    const text = cleanText(input.text);
    const dupe = this.#liveDuplicate(workspaceId, text);
    if (dupe) throw conflict(`That's already saved: ${quote(dupe.text)}`);
    const op = this.#db.tx(() => {
      const record = this.#insertItem(workspaceId, { category, certainty, text, origin: actor.kind === 'import' ? 'import' : 'user' });
      this.#recordChange(workspaceId, actor.kind === 'import' ? 'import' : 'user_edit', `Added ${categorySingular(category)}: ${quote(text)}`, [record]);
      return record;
    });
    this.#bus.publish({ type: 'memory.changed', workspaceId });
    return toItem(this.#itemRow(op.itemId));
  }

  updateItem(
    actor: MemoryActor,
    itemId: string,
    patch: { category?: MemoryCategory; certainty?: MemoryCertainty; text?: string },
    expectedVersion?: number,
  ): MemoryItemDto {
    this.#assertDirectEditor(actor);
    const row = this.#itemRow(itemId);
    if (row.deleted_at) throw conflict('This memory item was deleted.');
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw conflict('This memory item was changed in another window. Reload to see the latest version.');
    }
    const clean = {
      category: patch.category !== undefined ? assertCategory(patch.category) : undefined,
      certainty: patch.certainty !== undefined ? assertCertainty(patch.certainty) : undefined,
      text: patch.text !== undefined ? cleanText(patch.text) : undefined,
    };
    if (clean.text) {
      const dupe = this.#liveDuplicate(row.workspace_id, clean.text, row.id);
      if (dupe) throw conflict(`That's already saved: ${quote(dupe.text)}`);
    }
    this.#db.tx(() => {
      const record = this.#updateItem(row, clean);
      this.#recordChange(row.workspace_id, 'user_edit', `Edited ${categorySingular(record.after!.category)}: ${quote(record.after!.text)}`, [record]);
    });
    this.#bus.publish({ type: 'memory.changed', workspaceId: row.workspace_id });
    return toItem(this.#itemRow(itemId));
  }

  deleteItem(actor: MemoryActor, itemId: string): void {
    this.#assertDirectEditor(actor);
    const row = this.#itemRow(itemId);
    if (row.deleted_at) return;
    this.#db.tx(() => {
      const record = this.#removeItem(row);
      this.#recordChange(row.workspace_id, 'user_edit', `Deleted ${categorySingular(row.category)}: ${quote(row.text)}`, [record]);
    });
    this.#bus.publish({ type: 'memory.changed', workspaceId: row.workspace_id });
  }

  // ── Proposals ──────────────────────────────────────────────────────────────
  #proposalRow(id: string): ProposalRow {
    const row = this.#db.get<ProposalRow>('SELECT * FROM memory_proposals WHERE id = ?', id);
    if (!row) throw notFound('Memory suggestion');
    return row;
  }

  #toProposal(row: ProposalRow): MemoryProposalDto {
    const target = row.target_item_id ? this.#db.get<{ text: string }>('SELECT text FROM memory_items WHERE id = ?', row.target_item_id) : null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      op: row.op,
      targetItemId: row.target_item_id,
      targetText: target?.text ?? null,
      category: row.category,
      certainty: row.certainty,
      text: row.text,
      reason: row.reason,
      evidence: row.evidence,
      importance: row.importance,
      sourceKind: row.source_kind,
      sourceConversationId: row.source_conversation_id,
      sourceTitle: row.source_title,
      status: row.status,
      statusDetail: row.status_detail,
      changeId: row.change_id,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }

  getProposal(id: string): MemoryProposalDto {
    return this.#toProposal(this.#proposalRow(id));
  }

  listProposals(workspaceId: string, filter: 'pending' | 'recent' = 'pending'): MemoryProposalDto[] {
    const rows =
      filter === 'pending'
        ? this.#db.all<ProposalRow>("SELECT * FROM memory_proposals WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC", workspaceId)
        : this.#db.all<ProposalRow>(
            `SELECT * FROM memory_proposals WHERE workspace_id = ? AND (status = 'pending' OR created_at >= ?)
             ORDER BY created_at DESC LIMIT 200`,
            workspaceId,
            new Date(Date.now() - 30 * 86_400_000).toISOString(),
          );
    return rows.map((r) => this.#toProposal(r));
  }

  /** Autosave may only record "confirmed" when the user actually said it in the source conversation. */
  #evidenceSupportsConfirmed(evidence: string | null, conversationId: string): boolean {
    if (!evidence || normalizeText(evidence).length < 8) return false;
    const needle = normalizeText(evidence);
    const userMessages = this.#db.all<{ content: string }>(
      "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'",
      conversationId,
    );
    return userMessages.some((m) => normalizeText(m.content).includes(needle) || coverage(evidence, m.content) >= 0.8);
  }

  propose(actor: MemoryActor, workspaceId: string, input: ProposalInput): MemoryProposalDto {
    const source = this.#assertProposer(actor, workspaceId);
    this.#goalsWorkspace(workspaceId);

    let op = input.op;
    if (!['add', 'update', 'remove'].includes(op)) throw badRequest('A memory suggestion must add, update, or remove.');
    const importance = input.importance && ['low', 'medium', 'high'].includes(input.importance) ? input.importance : 'medium';
    const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const evidence = input.evidence ? input.evidence.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : null;
    let targetItemId: string | null = input.targetItemId ?? null;
    let category = input.category ? assertCategory(input.category) : null;
    let certainty = input.certainty ? assertCertainty(input.certainty) : null;
    let text = input.text ? cleanText(input.text) : null;
    let status: ProposalStatus = 'pending';
    let statusDetail: string | null = null;

    let target: ItemRow | null = null;
    if (op === 'add') {
      if (!category || !certainty || !text) throw badRequest('A suggestion to add memory needs a category, a certainty, and text.');
      const items = this.#db.all<ItemRow>('SELECT * FROM memory_items WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId);
      let best: ItemRow | null = null;
      let bestScore = 0;
      for (const item of items) {
        const score = similarity(item.text, text);
        if (score > bestScore) {
          best = item;
          bestScore = score;
        }
      }
      if (best && bestScore >= DUPLICATE_THRESHOLD) {
        status = 'duplicate';
        statusDetail = `Already saved: ${quote(best.text)}`;
      } else if (best && bestScore >= REVISION_THRESHOLD && best.category === category) {
        // A close variant of an existing item is treated as a revision, so memory doesn't accumulate contradictions.
        op = 'update';
        targetItemId = best.id;
        target = best;
        statusDetail = `Revises a similar saved item: ${quote(best.text)}`;
      }
    } else {
      if (!targetItemId) throw badRequest('Say which saved memory item to change (its id).');
      target = this.#db.get<ItemRow>('SELECT * FROM memory_items WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', targetItemId, workspaceId) ?? null;
      if (!target) throw badRequest('There is no saved memory item with that id in this mission.');
      if (op === 'update') {
        const unchanged =
          (text === null || normalizeText(text) === normalizeText(target.text)) &&
          (category === null || category === target.category) &&
          (certainty === null || certainty === target.certainty);
        if (unchanged) {
          status = 'duplicate';
          statusDetail = 'Matches what is already saved.';
        }
      }
    }

    if (status === 'pending') {
      const pending = this.#db.all<ProposalRow>("SELECT * FROM memory_proposals WHERE workspace_id = ? AND status = 'pending'", workspaceId);
      const samePending = pending.find(
        (p) => p.op === op && p.target_item_id === targetItemId && (op === 'remove' || (p.text && text && similarity(p.text, text) >= DUPLICATE_THRESHOLD)),
      );
      if (samePending) {
        status = 'duplicate';
        statusDetail = 'The same suggestion is already waiting for review.';
      }
    }

    const id = newId();
    const now = nowIso();
    this.#db.tx(() => {
      if (status === 'pending' && targetItemId) {
        this.#db.run(
          `UPDATE memory_proposals SET status = 'stale', status_detail = 'Replaced by a newer suggestion.', decided_at = ?
           WHERE workspace_id = ? AND status = 'pending' AND target_item_id = ?`,
          now,
          workspaceId,
          targetItemId,
        );
      }
      this.#db.run(
        `INSERT INTO memory_proposals (id, workspace_id, op, target_item_id, category, certainty, text, reason, evidence, importance,
           source_kind, source_conversation_id, source_title, source_message_id, status, status_detail, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        workspaceId,
        op,
        targetItemId,
        category ?? (op === 'update' ? null : target?.category ?? null),
        certainty,
        text,
        reason,
        evidence,
        importance,
        actor.kind === 'goals_assistant' ? 'goals_assistant' : 'suggestion_scan',
        source.conversationId,
        source.title,
        input.sourceMessageId ?? null,
        status,
        statusDetail,
        now,
        status === 'pending' ? null : now,
      );
    });

    if (status === 'pending') {
      const settings = this.#workspaces.getSettings(workspaceId);
      if (settings.memoryAutosave) {
        const resultingCertainty = certainty ?? target?.certainty ?? null;
        let blocker: string | null = null;
        if (op === 'remove') blocker = 'Removals always need your approval.';
        else if (importance === 'low') blocker = 'Autosave only applies important updates.';
        else if (resultingCertainty === 'confirmed' && !this.#evidenceSupportsConfirmed(evidence, source.conversationId)) {
          blocker = 'Marked as confirmed, but no matching statement from you was found, so it needs your approval.';
        }
        if (blocker) {
          this.#db.run('UPDATE memory_proposals SET status_detail = ? WHERE id = ?', blocker, id);
        } else {
          this.#applyProposal(id, 'autosave');
        }
      }
    }
    this.#bus.publish({ type: 'proposals.changed', workspaceId });
    return this.getProposal(id);
  }

  #applyProposal(proposalId: string, origin: 'proposal_approved' | 'autosave'): void {
    this.#db.tx(() => {
      const p = this.#proposalRow(proposalId);
      if (p.status !== 'pending') throw conflict('This suggestion has already been decided.');
      let record: OpRecord;
      let summary: string;
      const itemOrigin: MemoryOrigin = origin === 'autosave' ? 'autosave' : 'approved';
      if (p.op === 'add') {
        record = this.#insertItem(p.workspace_id, {
          category: assertCategory(p.category),
          certainty: assertCertainty(p.certainty),
          text: cleanText(p.text),
          origin: itemOrigin,
          sourceConversationId: p.source_conversation_id,
          sourceTitle: p.source_title,
        });
        summary = `Added ${categorySingular(record.after!.category)}: ${quote(record.after!.text)}`;
      } else {
        const target = p.target_item_id
          ? this.#db.get<ItemRow>('SELECT * FROM memory_items WHERE id = ? AND deleted_at IS NULL', p.target_item_id)
          : undefined;
        if (!target) {
          this.#db.run(
            "UPDATE memory_proposals SET status = 'stale', status_detail = 'The item it refers to no longer exists.', decided_at = ? WHERE id = ?",
            nowIso(),
            proposalId,
          );
          throw conflict('The memory item this suggestion refers to no longer exists.');
        }
        if (p.op === 'update') {
          record = this.#updateItem(target, {
            category: p.category ?? undefined,
            certainty: p.certainty ?? undefined,
            text: p.text ? cleanText(p.text) : undefined,
          });
          summary = `Updated ${categorySingular(record.after!.category)}: ${quote(record.after!.text)}`;
        } else {
          record = this.#removeItem(target);
          summary = `Removed ${categorySingular(target.category)}: ${quote(target.text)}`;
        }
      }
      const changeId = this.#recordChange(p.workspace_id, origin, summary, [record], { proposalId });
      this.#db.run(
        'UPDATE memory_proposals SET status = ?, change_id = ?, decided_at = ? WHERE id = ?',
        origin === 'autosave' ? 'auto_applied' : 'approved',
        changeId,
        nowIso(),
        proposalId,
      );
    });
    const workspaceId = this.#proposalRow(proposalId).workspace_id;
    this.#bus.publish({ type: 'memory.changed', workspaceId });
  }

  approve(
    actor: MemoryActor,
    proposalId: string,
    edits: { text?: string; category?: MemoryCategory; certainty?: MemoryCertainty } = {},
  ): MemoryProposalDto {
    this.#assertDirectEditor(actor);
    const p = this.#proposalRow(proposalId);
    if (p.status !== 'pending') throw conflict('This suggestion has already been decided.');
    if (edits.text !== undefined || edits.category !== undefined || edits.certainty !== undefined) {
      if (p.op === 'remove') throw badRequest("A removal can't be edited; approve or reject it.");
      this.#db.run(
        'UPDATE memory_proposals SET text = ?, category = ?, certainty = ? WHERE id = ?',
        edits.text !== undefined ? cleanText(edits.text) : p.text,
        edits.category !== undefined ? assertCategory(edits.category) : p.category,
        edits.certainty !== undefined ? assertCertainty(edits.certainty) : p.certainty,
        proposalId,
      );
    }
    this.#applyProposal(proposalId, 'proposal_approved');
    this.#bus.publish({ type: 'proposals.changed', workspaceId: p.workspace_id });
    return this.getProposal(proposalId);
  }

  reject(actor: MemoryActor, proposalId: string): MemoryProposalDto {
    this.#assertDirectEditor(actor);
    const p = this.#proposalRow(proposalId);
    if (p.status !== 'pending') throw conflict('This suggestion has already been decided.');
    this.#db.run("UPDATE memory_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", nowIso(), proposalId);
    this.#bus.publish({ type: 'proposals.changed', workspaceId: p.workspace_id });
    return this.getProposal(proposalId);
  }

  // ── History & undo ─────────────────────────────────────────────────────────
  listChanges(workspaceId: string, limit = 100): MemoryChangeDto[] {
    const changes = this.#db.all<ChangeRow>('SELECT * FROM memory_changes WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', workspaceId, limit);
    return changes.map((c) => ({
      id: c.id,
      workspaceId: c.workspace_id,
      origin: c.origin,
      summary: c.summary,
      proposalId: c.proposal_id,
      undoOfChangeId: c.undo_of_change_id,
      undoneByChangeId: c.undone_by_change_id,
      createdAt: c.created_at,
      ops: this.#db
        .all<{ item_id: string; op: 'add' | 'update' | 'remove'; before_json: string | null; after_json: string | null }>(
          'SELECT item_id, op, before_json, after_json FROM memory_change_ops WHERE change_id = ? ORDER BY id',
          c.id,
        )
        .map((o) => ({
          itemId: o.item_id,
          op: o.op,
          before: o.before_json ? (JSON.parse(o.before_json) as MemorySnapshot) : null,
          after: o.after_json ? (JSON.parse(o.after_json) as MemorySnapshot) : null,
        })),
    }));
  }

  undo(actor: MemoryActor, changeId: string): MemoryChangeDto {
    this.#assertDirectEditor(actor);
    const change = this.#db.get<ChangeRow>('SELECT * FROM memory_changes WHERE id = ?', changeId);
    if (!change) throw notFound('Memory change');
    if (change.undone_by_change_id) throw conflict('That change was already undone.');
    const ops = this.#db.all<{ item_id: string; op: 'add' | 'update' | 'remove'; before_json: string | null; after_json: string | null }>(
      'SELECT item_id, op, before_json, after_json FROM memory_change_ops WHERE change_id = ? ORDER BY id DESC',
      changeId,
    );
    const newChangeId = this.#db.tx(() => {
      const records: OpRecord[] = [];
      for (const op of ops) {
        const row = this.#db.get<ItemRow>('SELECT * FROM memory_items WHERE id = ?', op.item_id);
        const after = op.after_json ? (JSON.parse(op.after_json) as Snapshot) : null;
        const before = op.before_json ? (JSON.parse(op.before_json) as Snapshot) : null;
        const laterEdit = conflict('That memory item has changed since this edit. Undo the later change first.');
        if (!row) throw laterEdit;
        if (op.op === 'add') {
          if (row.deleted_at || row.version !== after?.version) throw laterEdit;
          records.push(this.#removeItem(row));
        } else if (op.op === 'update') {
          if (row.deleted_at || row.version !== after?.version || !before) throw laterEdit;
          records.push(this.#updateItem(row, { category: before.category, certainty: before.certainty, text: before.text }));
        } else {
          if (!row.deleted_at) throw laterEdit;
          const restoredBefore = snapshotOf(row);
          this.#db.run('UPDATE memory_items SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?', nowIso(), row.id);
          records.push({ itemId: row.id, op: 'add', before: restoredBefore, after: snapshotOf(this.#itemRow(row.id)) });
        }
      }
      const id = this.#recordChange(change.workspace_id, 'undo', `Undid: ${change.summary}`, records, { undoOfChangeId: changeId });
      this.#db.run('UPDATE memory_changes SET undone_by_change_id = ? WHERE id = ?', id, changeId);
      return id;
    });
    this.#bus.publish({ type: 'memory.changed', workspaceId: change.workspace_id });
    return this.listChanges(change.workspace_id).find((c) => c.id === newChangeId)!;
  }
}
