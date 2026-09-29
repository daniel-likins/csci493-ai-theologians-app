import type {
  ContextReport,
  ConversationDto,
  ConversationKind,
  ConversationListItem,
  FolderDto,
  MessageDto,
  MessageErrorDto,
  MessagePart,
  MessageStatus,
  ProfileKind,
  SearchHit,
  UsageDto,
} from '../../../shared/types.ts';
import type { ProfileService } from '../assistants/profiles.ts';
import { parseJson, toBool, type Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { containsCjk, escapeLike, ftsPrefixQuery, titleFromText } from '../lib/text.ts';
import { toAttachmentDto, type AttachmentRow } from './attachment-rows.ts';

interface ConversationRow {
  id: string;
  workspace_id: string | null;
  kind: ConversationKind;
  folder_id: string | null;
  title: string;
  title_is_custom: number;
  selected_profile_id: string | null;
  selected_model_id: string | null;
  draft: string;
  draft_attachment_ids_json: string;
  draft_updated_at: string | null;
  web_search_enabled: number;
  files_enabled: number;
  summary_text: string | null;
  summary_through_seq: number;
  summary_updated_at: string | null;
  memory_scanned_through_seq: number;
  memory_scanned_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  parts_json: string;
  attachment_ids_json: string;
  profile_id: string | null;
  profile_name: string | null;
  profile_kind: ProfileKind | null;
  model_id: string | null;
  model_label: string | null;
  connection_label: string | null;
  status: MessageStatus;
  error_json: string | null;
  usage_json: string | null;
  context_json: string | null;
  superseded: number;
  created_at: string;
  updated_at: string;
}

function toConversation(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    folderId: row.folder_id,
    title: row.title,
    titleIsCustom: toBool(row.title_is_custom),
    selectedProfileId: row.selected_profile_id,
    selectedModelId: row.selected_model_id,
    draft: row.draft,
    draftAttachmentIds: parseJson<string[]>(row.draft_attachment_ids_json, []),
    draftUpdatedAt: row.draft_updated_at,
    webSearchEnabled: toBool(row.web_search_enabled),
    filesEnabled: toBool(row.files_enabled),
    summaryThroughSeq: row.summary_through_seq,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

/** Internal conversation state used by context building and memory scanning (not sent to the UI). */
export interface ConversationInternals {
  summaryText: string | null;
  summaryThroughSeq: number;
  summaryUpdatedAt: string | null;
  memoryScannedThroughSeq: number;
  memoryScannedAt: string | null;
}

export interface CreateConversationInput {
  workspaceId: string | null;
  kind: ConversationKind;
  title?: string;
  folderId?: string | null;
  selectedProfileId?: string | null;
  selectedModelId?: string | null;
  webSearchEnabled?: boolean;
  filesEnabled?: boolean;
}

export interface ConversationPatch {
  title?: string;
  folderId?: string | null;
  selectedProfileId?: string | null;
  selectedModelId?: string | null;
  webSearchEnabled?: boolean;
  filesEnabled?: boolean;
}

export interface AppendMessageInput {
  conversationId: string;
  role: 'user' | 'assistant';
  content?: string;
  parts?: MessagePart[];
  attachmentIds?: string[];
  profile?: { id: string; name: string; kind: ProfileKind } | null;
  model?: { id: string; label: string; connectionLabel: string } | null;
  status?: MessageStatus;
}

export interface MessagePatch {
  content?: string;
  parts?: MessagePart[];
  status?: MessageStatus;
  error?: MessageErrorDto | null;
  usage?: UsageDto | null;
  context?: ContextReport | null;
  superseded?: boolean;
}

/** Derive searchable/plain content for an assistant message from its parts. */
export function textFromParts(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

export class ConversationService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #profiles: ProfileService;

  constructor(db: Db, bus: EventBus, profiles: ProfileService) {
    this.#db = db;
    this.#bus = bus;
    this.#profiles = profiles;
  }

  // ── Folders ────────────────────────────────────────────────────────────────
  listFolders(workspaceId: string): FolderDto[] {
    return this.#db
      .all<{ id: string; workspace_id: string; name: string; sort_order: number }>(
        'SELECT id, workspace_id, name, sort_order FROM folders WHERE workspace_id = ? ORDER BY sort_order, name COLLATE NOCASE',
        workspaceId,
      )
      .map((r) => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, sortOrder: r.sort_order }));
  }

  getFolder(id: string): FolderDto {
    const r = this.#db.get<{ id: string; workspace_id: string; name: string; sort_order: number }>(
      'SELECT id, workspace_id, name, sort_order FROM folders WHERE id = ?',
      id,
    );
    if (!r) throw notFound('Folder');
    return { id: r.id, workspaceId: r.workspace_id, name: r.name, sortOrder: r.sort_order };
  }

  #cleanFolderName(workspaceId: string, name: string, exceptId?: string): string {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw badRequest('A folder needs a name.');
    if (clean.length > 80) throw badRequest('Folder names can be at most 80 characters.');
    const dupe = this.#db.get<{ id: string }>(
      'SELECT id FROM folders WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?',
      workspaceId,
      clean,
      exceptId ?? null,
    );
    if (dupe) throw conflict(`There is already a folder named “${clean}”.`);
    return clean;
  }

  createFolder(workspaceId: string, name: string): FolderDto {
    if (!this.#db.get('SELECT id FROM workspaces WHERE id = ?', workspaceId)) throw notFound('Workspace');
    const clean = this.#cleanFolderName(workspaceId, name);
    const id = newId();
    const now = nowIso();
    const order = (this.#db.get<{ n: number | null }>('SELECT MAX(sort_order) n FROM folders WHERE workspace_id = ?', workspaceId)?.n ?? -1) + 1;
    this.#db.run(
      'INSERT INTO folders (id, workspace_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      clean,
      order,
      now,
      now,
    );
    this.#bus.publish({ type: 'folders.changed', workspaceId });
    return this.getFolder(id);
  }

  renameFolder(id: string, name: string): FolderDto {
    const folder = this.getFolder(id);
    const clean = this.#cleanFolderName(folder.workspaceId, name, id);
    this.#db.run('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?', clean, nowIso(), id);
    this.#bus.publish({ type: 'folders.changed', workspaceId: folder.workspaceId });
    return this.getFolder(id);
  }

  /** Deleting a folder keeps its chats; they move back to the unfiled list. */
  deleteFolder(id: string): void {
    const folder = this.getFolder(id);
    this.#db.tx(() => {
      this.#db.run('UPDATE conversations SET folder_id = NULL, version = version + 1, updated_at = ? WHERE folder_id = ?', nowIso(), id);
      this.#db.run('DELETE FROM folders WHERE id = ?', id);
    });
    this.#bus.publish({ type: 'folders.changed', workspaceId: folder.workspaceId });
    this.#bus.publish({ type: 'conversations.changed', workspaceId: folder.workspaceId });
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  list(workspaceId: string | null, kind: ConversationKind): ConversationListItem[] {
    return this.#db
      .all<ConversationRow>(
        'SELECT * FROM conversations WHERE workspace_id IS ? AND kind = ? ORDER BY COALESCE(last_message_at, created_at) DESC',
        workspaceId,
        kind,
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        folderId: r.folder_id,
        updatedAt: r.updated_at,
        lastMessageAt: r.last_message_at,
        hasDraft: r.draft.trim().length > 0,
      }));
  }

  find(id: string): ConversationDto | null {
    const row = this.#db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    return row ? toConversation(row) : null;
  }

  get(id: string): ConversationDto {
    const conversation = this.find(id);
    if (!conversation) throw notFound('Conversation');
    return conversation;
  }

  internals(id: string): ConversationInternals {
    const row = this.#db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    if (!row) throw notFound('Conversation');
    return {
      summaryText: row.summary_text,
      summaryThroughSeq: row.summary_through_seq,
      summaryUpdatedAt: row.summary_updated_at,
      memoryScannedThroughSeq: row.memory_scanned_through_seq,
      memoryScannedAt: row.memory_scanned_at,
    };
  }

  #validateSelection(
    scope: { kind: ConversationKind; workspaceId: string | null },
    profileId: string | null | undefined,
    modelId: string | null | undefined,
  ): void {
    if (profileId) {
      const profile = this.#profiles.get(profileId);
      if (!this.#profiles.isUsableIn(profile, scope)) {
        throw forbidden(`${profile.name} can't be used in this conversation.`);
      }
    }
    if (modelId && !this.#db.get('SELECT id FROM models WHERE id = ?', modelId)) throw notFound('Model');
  }

  #validateFolder(workspaceId: string | null, folderId: string | null | undefined): void {
    if (!folderId) return;
    const folder = this.getFolder(folderId);
    if (folder.workspaceId !== workspaceId) throw forbidden('Chats can only be moved to folders in the same mission.');
  }

  create(input: CreateConversationInput): ConversationDto {
    if (input.kind === 'master' && input.workspaceId !== null) throw badRequest('Master conversations belong to Home.');
    if (input.kind !== 'master') {
      if (!input.workspaceId || !this.#db.get('SELECT id FROM workspaces WHERE id = ?', input.workspaceId)) {
        throw notFound('Workspace');
      }
    }
    if (input.kind === 'goals' && this.#db.get("SELECT id FROM conversations WHERE workspace_id = ? AND kind = 'goals'", input.workspaceId)) {
      throw conflict('This mission already has a Goals conversation.');
    }
    const scope = { kind: input.kind, workspaceId: input.workspaceId };
    const profileId =
      input.selectedProfileId ??
      (input.kind === 'master'
        ? this.#profiles.getMaster().id
        : input.kind === 'goals'
          ? this.#profiles.getGoals(input.workspaceId!).id
          : this.#profiles.getDefaultGeneral().id);
    this.#validateSelection(scope, profileId, input.selectedModelId);
    this.#validateFolder(input.workspaceId, input.folderId);

    const id = newId();
    const now = nowIso();
    const title = input.title?.trim() || (input.kind === 'goals' ? 'Goals' : input.kind === 'master' ? 'Conversation' : 'New chat');
    this.#db.run(
      `INSERT INTO conversations (id, workspace_id, kind, folder_id, title, title_is_custom, selected_profile_id, selected_model_id,
         web_search_enabled, files_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.workspaceId,
      input.kind,
      input.folderId ?? null,
      title,
      Boolean(input.title?.trim()),
      profileId,
      input.selectedModelId ?? null,
      input.webSearchEnabled ?? false,
      input.filesEnabled ?? false,
      now,
      now,
    );
    this.#bus.publish({ type: 'conversations.changed', workspaceId: input.workspaceId, conversationId: id });
    return this.get(id);
  }

  getOrCreateGoals(workspaceId: string): ConversationDto {
    const row = this.#db.get<ConversationRow>("SELECT * FROM conversations WHERE workspace_id = ? AND kind = 'goals'", workspaceId);
    if (row) return toConversation(row);
    return this.create({ workspaceId, kind: 'goals' });
  }

  update(id: string, patch: ConversationPatch, expectedVersion?: number, originClientId?: string): ConversationDto {
    const current = this.get(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw conflict('This chat was changed in another window. Reload to see the latest version.', { current });
    }
    const scope = { kind: current.kind, workspaceId: current.workspaceId };
    if (patch.selectedProfileId !== undefined || patch.selectedModelId !== undefined) {
      this.#validateSelection(scope, patch.selectedProfileId, patch.selectedModelId);
    }
    if (patch.selectedProfileId === null) throw badRequest('A conversation always has an assistant selected.');
    if (patch.folderId !== undefined) {
      if (current.kind !== 'chat' && patch.folderId !== null) throw badRequest('Only mission chats can be placed in folders.');
      this.#validateFolder(current.workspaceId, patch.folderId);
    }
    let title = current.title;
    let titleIsCustom = current.titleIsCustom;
    if (patch.title !== undefined) {
      title = patch.title.trim().replace(/\s+/g, ' ');
      if (!title) throw badRequest('A chat needs a title.');
      if (title.length > 200) throw badRequest('Titles can be at most 200 characters.');
      titleIsCustom = true;
    }
    const result = this.#db.run(
      `UPDATE conversations SET title = ?, title_is_custom = ?, folder_id = ?, selected_profile_id = ?, selected_model_id = ?,
         web_search_enabled = ?, files_enabled = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
      title,
      titleIsCustom,
      patch.folderId !== undefined ? patch.folderId : current.folderId,
      patch.selectedProfileId !== undefined ? patch.selectedProfileId : current.selectedProfileId,
      patch.selectedModelId !== undefined ? patch.selectedModelId : current.selectedModelId,
      patch.webSearchEnabled ?? current.webSearchEnabled,
      patch.filesEnabled ?? current.filesEnabled,
      nowIso(),
      id,
      current.version,
    );
    if (result.changes === 0) throw conflict('This chat was changed in another window. Reload to see the latest version.');
    this.#bus.publish({ type: 'conversation.updated', conversationId: id, workspaceId: current.workspaceId }, originClientId);
    this.#bus.publish({ type: 'conversations.changed', workspaceId: current.workspaceId, conversationId: id }, originClientId);
    return this.get(id);
  }

  /** Give an untitled chat a title from its first message. No model call. */
  autoTitle(id: string, text: string): void {
    const current = this.get(id);
    if (current.titleIsCustom || current.kind === 'goals' || !['New chat', 'Conversation'].includes(current.title)) return;
    this.#db.run('UPDATE conversations SET title = ?, version = version + 1, updated_at = ? WHERE id = ?', titleFromText(text), nowIso(), id);
  }

  /** Drafts are last-write-wins and don't bump the version, so typing never conflicts with a rename. */
  saveDraft(id: string, draft: string, attachmentIds: string[], originClientId?: string): { updatedAt: string } {
    const current = this.get(id);
    const updatedAt = nowIso();
    this.#db.run(
      'UPDATE conversations SET draft = ?, draft_attachment_ids_json = ?, draft_updated_at = ? WHERE id = ?',
      draft,
      JSON.stringify(attachmentIds),
      updatedAt,
      id,
    );
    this.#bus.publish(
      { type: 'draft.updated', key: `conversation:${id}`, conversationId: id, draft, attachmentIds, updatedAt },
      originClientId,
    );
    if ((current.draft.trim().length > 0) !== (draft.trim().length > 0)) {
      this.#bus.publish({ type: 'conversations.changed', workspaceId: current.workspaceId, conversationId: id }, originClientId);
    }
    return { updatedAt };
  }

  setSummary(id: string, summaryText: string, throughSeq: number): void {
    this.#db.run(
      'UPDATE conversations SET summary_text = ?, summary_through_seq = ?, summary_updated_at = ? WHERE id = ?',
      summaryText,
      throughSeq,
      nowIso(),
      id,
    );
  }

  setMemoryScanned(id: string, throughSeq: number): void {
    this.#db.run(
      'UPDATE conversations SET memory_scanned_through_seq = MAX(memory_scanned_through_seq, ?), memory_scanned_at = ? WHERE id = ?',
      throughSeq,
      nowIso(),
      id,
    );
  }

  delete(id: string): void {
    const current = this.get(id);
    this.#db.run('DELETE FROM conversations WHERE id = ?', id);
    this.#bus.publish({ type: 'conversations.changed', workspaceId: current.workspaceId, conversationId: id });
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  #toMessage(row: MessageRow, attachments: Map<string, AttachmentRow>): MessageDto {
    const attachmentIds = parseJson<string[]>(row.attachment_ids_json, []);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      role: row.role,
      content: row.content,
      parts: parseJson<MessagePart[]>(row.parts_json, []),
      attachments: attachmentIds.map((a) => attachments.get(a)).filter((a): a is AttachmentRow => !!a).map(toAttachmentDto),
      profileId: row.profile_id,
      profileName: row.profile_name,
      profileKind: row.profile_kind,
      modelId: row.model_id,
      modelLabel: row.model_label,
      connectionLabel: row.connection_label,
      status: row.status,
      error: parseJson<MessageErrorDto | null>(row.error_json, null),
      usage: parseJson<UsageDto | null>(row.usage_json, null),
      context: parseJson<ContextReport | null>(row.context_json, null),
      superseded: toBool(row.superseded),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #attachmentMap(conversationId: string): Map<string, AttachmentRow> {
    const rows = this.#db.all<AttachmentRow>('SELECT * FROM attachments WHERE conversation_id = ?', conversationId);
    return new Map(rows.map((r) => [r.id, r]));
  }

  listMessages(conversationId: string): MessageDto[] {
    const attachments = this.#attachmentMap(conversationId);
    return this.#db
      .all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId)
      .map((r) => this.#toMessage(r, attachments));
  }

  getMessage(id: string): MessageDto {
    const row = this.#db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw notFound('Message');
    return this.#toMessage(row, this.#attachmentMap(row.conversation_id));
  }

  appendMessage(input: AppendMessageInput): MessageDto {
    const id = newId();
    const now = nowIso();
    const parts = input.parts ?? [];
    const content = input.content ?? textFromParts(parts);
    this.#db.tx(() => {
      const conversation = this.get(input.conversationId);
      const seq = (this.#db.get<{ s: number | null }>('SELECT MAX(seq) s FROM messages WHERE conversation_id = ?', conversation.id)?.s ?? 0) + 1;
      this.#db.run(
        `INSERT INTO messages (id, conversation_id, seq, role, content, parts_json, attachment_ids_json, profile_id, profile_name,
           profile_kind, model_id, model_label, connection_label, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        conversation.id,
        seq,
        input.role,
        content,
        JSON.stringify(parts),
        JSON.stringify(input.attachmentIds ?? []),
        input.profile?.id ?? null,
        input.profile?.name ?? null,
        input.profile?.kind ?? null,
        input.model?.id ?? null,
        input.model?.label ?? null,
        input.model?.connectionLabel ?? null,
        input.status ?? 'complete',
        now,
        now,
      );
      this.#db.run('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', now, now, conversation.id);
    });
    return this.getMessage(id);
  }

  updateMessage(id: string, patch: MessagePatch): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.parts !== undefined) {
      sets.push('parts_json = ?', 'content = ?');
      params.push(JSON.stringify(patch.parts), patch.content ?? textFromParts(patch.parts));
    } else if (patch.content !== undefined) {
      sets.push('content = ?');
      params.push(patch.content);
    }
    if (patch.status !== undefined) (sets.push('status = ?'), params.push(patch.status));
    if (patch.error !== undefined) (sets.push('error_json = ?'), params.push(patch.error ? JSON.stringify(patch.error) : null));
    if (patch.usage !== undefined) (sets.push('usage_json = ?'), params.push(patch.usage ? JSON.stringify(patch.usage) : null));
    if (patch.context !== undefined) (sets.push('context_json = ?'), params.push(patch.context ? JSON.stringify(patch.context) : null));
    if (patch.superseded !== undefined) (sets.push('superseded = ?'), params.push(patch.superseded ? 1 : 0));
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(nowIso());
    this.#db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Messages left mid-generation by a crash or forced quit become 'interrupted' (their text is kept). */
  markInterruptedGenerations(): number {
    return this.#db.run(
      "UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status IN ('streaming', 'awaiting_approval')",
      nowIso(),
    ).changes;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  search(workspaceId: string | null, kinds: ConversationKind[], query: string, limit = 30): SearchHit[] {
    const q = query.trim();
    if (!q || kinds.length === 0) return [];
    const kindSql = kinds.map(() => '?').join(', ');
    const hits = new Map<string, SearchHit>();

    const titleRows = this.#db.all<{ id: string; title: string; folder_id: string | null; updated_at: string }>(
      `SELECT id, title, folder_id, updated_at FROM conversations
       WHERE workspace_id IS ? AND kind IN (${kindSql}) AND title LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?`,
      workspaceId,
      ...kinds,
      `%${escapeLike(q)}%`,
      limit,
    );
    for (const r of titleRows) {
      hits.set(r.id, { conversationId: r.id, title: r.title, folderId: r.folder_id, snippet: null, messageId: null, matchedIn: 'title', updatedAt: r.updated_at });
    }

    type MsgHit = { conversation_id: string; title: string; folder_id: string | null; updated_at: string; message_id: string; snippet: string };
    let messageRows: MsgHit[] = [];
    const fts = containsCjk(q) ? null : ftsPrefixQuery(q);
    if (fts) {
      messageRows = this.#db.all<MsgHit>(
        `SELECT c.id AS conversation_id, c.title, c.folder_id, c.updated_at, m.id AS message_id,
                snippet(messages_fts, 0, '«', '»', '…', 14) AS snippet
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? AND c.workspace_id IS ? AND c.kind IN (${kindSql})
         ORDER BY bm25(messages_fts) LIMIT ?`,
        fts,
        workspaceId,
        ...kinds,
        limit * 3,
      );
    } else {
      const rows = this.#db.all<Omit<MsgHit, 'snippet'> & { content: string }>(
        `SELECT c.id AS conversation_id, c.title, c.folder_id, c.updated_at, m.id AS message_id, m.content
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.content LIKE ? ESCAPE '\\' AND c.workspace_id IS ? AND c.kind IN (${kindSql})
         ORDER BY m.created_at DESC LIMIT ?`,
        `%${escapeLike(q)}%`,
        workspaceId,
        ...kinds,
        limit * 3,
      );
      messageRows = rows.map((r) => {
        const at = r.content.indexOf(q);
        const start = Math.max(0, at - 40);
        const snippet = `${start > 0 ? '…' : ''}${r.content.slice(start, at)}«${q}»${r.content.slice(at + q.length, at + q.length + 60)}…`;
        return { ...r, snippet };
      });
    }
    for (const r of messageRows) {
      const existing = hits.get(r.conversation_id);
      if (existing) {
        existing.snippet ??= r.snippet;
        existing.messageId ??= r.message_id;
        continue;
      }
      if (hits.size >= limit) break;
      hits.set(r.conversation_id, {
        conversationId: r.conversation_id,
        title: r.title,
        folderId: r.folder_id,
        snippet: r.snippet,
        messageId: r.message_id,
        matchedIn: 'message',
        updatedAt: r.updated_at,
      });
    }
    return [...hits.values()];
  }
}
