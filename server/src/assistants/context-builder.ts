import type { AttachmentDto, ContextReport, ConversationDto, MessageDto, ModelDto, ProfileDto, SourceRef } from '../../../shared/types.ts';
import type { ResolvedModel } from '../chat/model-runner.ts';
import type { Db } from '../db/database.ts';
import type { ConversationService } from '../domain/conversations.ts';
import type { WorkspaceService } from '../domain/workspaces.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { ftsQuery, truncate } from '../lib/text.ts';
import { estimateTokens, IMAGE_TOKEN_ESTIMATE, PDF_PAGE_TOKEN_ESTIMATE } from '../lib/tokens.ts';
import type { MemoryService } from '../memory/memory-service.ts';
import type { ChatMessage, ContentBlock } from '../providers/types.ts';
import type { AttachmentChunk, AttachmentService } from '../tools/attachments.ts';
import { policyFor } from './policy.ts';
import { buildSystemPrompt, type MemoryContext } from './prompt.ts';
import type { Summarizer } from './summarizer.ts';

export interface BuildContextInput {
  conversation: ConversationDto;
  history: MessageDto[];
  profile: ProfileDto;
  resolved: ResolvedModel;
  maxOutputTokens: number;
  toolNames: string[];
  workingFolder: string | null;
  preSearch: { query: string; results: SourceRef[] } | null;
  signal: AbortSignal;
  timeZone: string;
}

export interface BuiltContext {
  system: string;
  messages: ChatMessage[];
  report: ContextReport;
}

interface Rendered {
  seq: number;
  message: ChatMessage;
  tokens: number;
}

/** Reject attachments the selected model can't use, before anything is sent or saved. */
export function attachmentProblem(attachments: AttachmentDto[], model: ModelDto): string | null {
  for (const a of attachments) {
    if (a.kind === 'image' && !model.supportsImages) {
      return `${model.displayName} isn't set up to read images. Remove “${a.filename}”, or choose a model with image support (Settings → Models).`;
    }
    if (a.kind === 'unsupported') return `“${a.filename}” is a file type Theologians can't read. ${a.extractionDetail ?? ''}`.trim();
    if (a.extractionStatus === 'error') return `“${a.filename}” couldn't be read: ${a.extractionDetail ?? 'unknown error'}`;
    if (a.kind === 'pdf' && a.extractionStatus === 'no_text' && !model.supportsPdfs) {
      return `“${a.filename}” has no extractable text (it looks scanned), and ${model.displayName} isn't set up to read PDFs directly. Choose a model with PDF support, or attach a text-based PDF.`;
    }
  }
  return null;
}

function ranges(seqs: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of [...seqs].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && s === last[1] + 1) last[1] = s;
    else out.push([s, s]);
  }
  return out;
}

function formatRanges(r: [number, number][]): string {
  return r.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/**
 * Chooses what a model sees: short conversations are sent as-is; long ones use recent turns, a bounded
 * incremental summary of older turns, and older messages retrieved for relevance. Nothing is silently
 * dropped — omissions are reported on the response.
 */
export class ContextBuilder {
  readonly #db: Db;
  readonly #workspaces: WorkspaceService;
  readonly #memory: MemoryService;
  readonly #conversations: ConversationService;
  readonly #attachments: AttachmentService;
  readonly #summarizer: Summarizer;

  constructor(deps: {
    db: Db;
    workspaces: WorkspaceService;
    memory: MemoryService;
    conversations: ConversationService;
    attachments: AttachmentService;
    summarizer: Summarizer;
  }) {
    this.#db = deps.db;
    this.#workspaces = deps.workspaces;
    this.#memory = deps.memory;
    this.#conversations = deps.conversations;
    this.#attachments = deps.attachments;
    this.#summarizer = deps.summarizer;
  }

  /** What saved memory this assistant may read, strictly by policy. */
  memoryContextFor(profile: ProfileDto, conversation: ConversationDto): MemoryContext {
    const policy = policyFor(profile.kind);
    if (policy.memoryRead === 'all_missions_readonly') {
      return { kind: 'all_missions', views: this.#workspaces.listWithGoals().map((w) => this.#memory.view(w.id)) };
    }
    if (!conversation.workspaceId) return { kind: 'none' };
    const workspace = this.#workspaces.get(conversation.workspaceId);
    const settings = this.#workspaces.getSettings(workspace.id);
    if (policy.memoryRead === 'own_mission') {
      if (profile.workspaceId !== workspace.id || !workspace.hasGoals) return { kind: 'none' };
      return { kind: 'mission', view: this.#memory.view(workspace.id), autosave: settings.memoryAutosave };
    }
    if (settings.generalContext === 'none') return { kind: 'none' };
    const focus =
      settings.generalContext === 'description_and_focus' && workspace.hasGoals
        ? this.#memory
            .listItems(workspace.id)
            .filter((i) => i.category === 'current_focus' && i.certainty !== 'suggestion')
            .slice(0, 3)
        : [];
    return { kind: 'brief', workspace, focus };
  }

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const { conversation, profile, resolved } = input;
    const model = resolved.model;
    const workspace = conversation.workspaceId ? this.#workspaces.get(conversation.workspaceId) : null;
    const missions = this.#workspaces.listWithGoals();
    const memory = this.memoryContextFor(profile, conversation);
    const promptBase = {
      profile,
      conversationKind: conversation.kind,
      workspace,
      missions,
      memory,
      now: new Date(),
      timeZone: input.timeZone,
      toolNames: input.toolNames,
      workingFolder: input.workingFolder,
      preSearch: input.preSearch,
    };
    const baseSystem = buildSystemPrompt({ ...promptBase, earlierSummary: null, retrieved: [], attachmentExcerpts: [], omittedNote: null });
    const reserve = Math.max(512, Math.floor(model.contextWindow * 0.05));
    const budget = model.contextWindow - input.maxOutputTokens - estimateTokens(baseSystem) - input.toolNames.length * 220 - reserve;
    if (budget < 800) {
      throw new AppError(
        'context_too_small',
        `${model.displayName}'s context window (${model.contextWindow.toLocaleString()} tokens) is too small for this assistant's instructions and memory. If the model supports more, raise it in Settings → Models, or choose another model.`,
        400,
      );
    }

    const eligible = input.history.filter(
      (m) => !m.superseded && (m.role === 'user' || m.content.trim().length > 0 || m.parts.some((p) => p.type === 'tool_result')),
    );
    const latestUserIndex = eligible.findLastIndex((m) => m.role === 'user');
    const queryText = eligible[latestUserIndex]?.content ?? '';
    const imageTurns = new Set(
      eligible
        .filter((m) => m.role === 'user' && m.attachments.some((a) => a.kind === 'image'))
        .slice(-2)
        .map((m) => m.id),
    );

    const excerpts: AttachmentChunk[] = [];
    const rendered: Rendered[] = [];
    for (let i = 0; i < eligible.length; i++) {
      const message = eligible[i]!;
      rendered.push(
        message.role === 'user'
          ? await this.#renderUser(message, {
              isLatest: i === latestUserIndex,
              allowImages: imageTurns.has(message.id),
              model,
              budget,
              queryText,
              excerpts,
              canReadMore: input.toolNames.includes('read_attachment'),
            })
          : this.#renderAssistant(message, profile.id),
      );
    }

    const total = rendered.reduce((n, r) => n + r.tokens, 0);
    const notices: string[] = [];
    let windowStart = 0;
    let summary: { text: string; throughSeq: number } | null = null;
    let retrieved: { seq: number; role: 'user' | 'assistant'; text: string }[] = [];
    let omitted: [number, number][] = [];

    if (total > budget) {
      const last = rendered.at(-1);
      if (last && last.tokens > budget) {
        throw new AppError(
          'message_too_long',
          `Your message${eligible.at(-1)?.attachments.length ? ' and its attachments are' : ' is'} too long for ${model.displayName} (about ${last.tokens.toLocaleString()} tokens; about ${budget.toLocaleString()} available). Shorten it, remove an attachment, or choose a model with a larger context window.`,
          400,
        );
      }
      let used = 0;
      let i = rendered.length - 1;
      const recentBudget = Math.floor(budget * 0.6);
      for (; i >= 0; i--) {
        const t = rendered[i]!.tokens;
        if (i < rendered.length - 1 && used + t > recentBudget) break;
        used += t;
      }
      windowStart = i + 1;
      const older = eligible.slice(0, windowStart);

      if (older.length > 0) {
        try {
          summary = await this.#summarizer.catchUp(conversation, older, resolved, input.signal);
        } catch (err) {
          if (input.signal.aborted) throw err;
          notices.push(`A summary of earlier messages couldn't be created (${truncate(errorMessage(err), 160)}).`);
          const existing = this.#conversations.internals(conversation.id);
          if (existing.summaryText && existing.summaryThroughSeq > 0) {
            summary = { text: existing.summaryText, throughSeq: existing.summaryThroughSeq };
          }
        }
        if (summary) summary = { ...summary, text: truncate(summary.text, Math.floor(budget * 0.15) * 3) };
        retrieved = this.#retrieve(conversation.id, older, queryText, Math.floor(budget * 0.2));
        const covered = new Set(retrieved.map((r) => r.seq));
        omitted = ranges(older.filter((m) => m.seq > (summary?.throughSeq ?? 0) && !covered.has(m.seq)).map((m) => m.seq));
        if (omitted.length) {
          notices.push(
            `Messages ${formatRanges(omitted)} weren't sent because the conversation is longer than ${model.displayName}'s context window${summary ? ' and the summary covers only up to message ' + summary.throughSeq : ''}.`,
          );
        }
      }
    }

    // Keep attachment excerpts within a quarter of the budget.
    const seen = new Set<string>();
    const keptExcerpts: AttachmentChunk[] = [];
    let excerptTokens = 0;
    for (const e of excerpts) {
      const key = `${e.attachmentId}:${e.ordinal}`;
      if (seen.has(key)) continue;
      const t = estimateTokens(e.text);
      if (excerptTokens + t > budget * 0.25) break;
      seen.add(key);
      keptExcerpts.push(e);
      excerptTokens += t;
    }

    const system = buildSystemPrompt({
      ...promptBase,
      earlierSummary: summary,
      retrieved,
      attachmentExcerpts: keptExcerpts.map((e) => ({ filename: e.filename, pageStart: e.pageStart, pageEnd: e.pageEnd, text: e.text })),
      omittedNote: omitted.length ? `Some earlier messages (${formatRanges(omitted)}) are not included. Ask the user if you need them.` : null,
    });
    const window = rendered.slice(windowStart);
    const report: ContextReport = {
      estimatedTokens: estimateTokens(system) + window.reduce((n, r) => n + r.tokens, 0),
      budgetTokens: model.contextWindow - input.maxOutputTokens,
      totalMessages: eligible.length,
      includedMessages: window.length,
      summaryThroughSeq: summary?.throughSeq ?? null,
      retrievedSeqs: retrieved.map((r) => r.seq),
      omittedRanges: omitted,
      memoryIncluded: memory.kind === 'none' ? 'none' : memory.kind === 'brief' ? 'brief' : memory.kind === 'mission' ? 'mission' : 'all_missions',
      notices,
    };
    return { system, messages: window.map((r) => r.message), report };
  }

  async #renderUser(
    message: MessageDto,
    opts: { isLatest: boolean; allowImages: boolean; model: ModelDto; budget: number; queryText: string; excerpts: AttachmentChunk[]; canReadMore: boolean },
  ): Promise<Rendered> {
    const blocks: ContentBlock[] = [];
    let tokens = 0;
    if (message.content.trim()) {
      blocks.push({ type: 'text', text: message.content });
      tokens += estimateTokens(message.content);
    }
    const note = (text: string): void => {
      blocks.push({ type: 'text', text });
      tokens += estimateTokens(text);
    };
    for (const a of message.attachments) {
      if (a.kind === 'image') {
        if (opts.model.supportsImages && opts.allowImages) {
          blocks.push({ type: 'image', mimeType: a.mimeType, dataBase64: await this.#attachments.readBase64(a.id) });
          tokens += IMAGE_TOKEN_ESTIMATE;
        } else {
          note(opts.model.supportsImages ? `[Image “${a.filename}” was shared earlier]` : `[Image “${a.filename}” — the selected model can't view images]`);
        }
        continue;
      }
      if (a.kind === 'unsupported' || a.extractionStatus === 'error' || a.extractionStatus === 'unsupported') {
        note(`[Attachment “${a.filename}” couldn't be read: ${a.extractionDetail ?? 'unsupported file type'}]`);
        continue;
      }
      if (a.extractionStatus === 'no_text') {
        if (opts.isLatest && opts.model.supportsPdfs) {
          blocks.push({ type: 'pdf', filename: a.filename, dataBase64: await this.#attachments.readBase64(a.id) });
          tokens += (a.pageCount ?? 10) * PDF_PAGE_TOKEN_ESTIMATE;
        } else {
          note(`[PDF “${a.filename}” has no extractable text (it appears to be scanned)]`);
        }
        continue;
      }
      const full = this.#attachments.fullText(a.id);
      const fullTokens = estimateTokens(full);
      const label = a.kind === 'pdf' ? `PDF “${a.filename}” (${a.pageCount ?? '?'} pages)` : `file “${a.filename}”`;
      const partial = a.extractionStatus === 'partial' ? ` Note: ${a.extractionDetail}` : '';
      if (opts.isLatest && fullTokens <= opts.budget * 0.4) {
        note(`<attachment file="${a.filename}"${a.pageCount ? ` pages="${a.pageCount}"` : ''} id="${a.id}">\n${full}\n</attachment>${partial}`);
      } else {
        note(
          opts.isLatest
            ? `[The ${label} is too long to include in full. The most relevant excerpts are in the context above${opts.canReadMore ? '; use read_attachment to read specific pages' : ''}. Attachment id: ${a.id}.${partial}]`
            : `[The ${label} was shared earlier. Attachment id: ${a.id}.]`,
        );
        opts.excerpts.push(...this.#attachments.search([a.id], opts.queryText, opts.isLatest ? 6 : 2));
      }
    }
    if (blocks.length === 0) note('(empty message)');
    return { seq: message.seq, message: { role: 'user', content: blocks }, tokens };
  }

  #renderAssistant(message: MessageDto, currentProfileId: string): Rendered {
    const segments: string[] = [];
    if (message.profileId && message.profileId !== currentProfileId && message.profileName) {
      segments.push(`[Earlier reply from ${message.profileName}${message.modelLabel ? ` using ${message.modelLabel}` : ''}]`);
    }
    if (message.parts.length === 0 && message.content) segments.push(message.content);
    for (const part of message.parts) {
      if (part.type === 'text') segments.push(part.text);
      else if (part.type === 'tool_result') {
        segments.push(`[Tool ${part.name}${part.isError ? ' (failed)' : ''}: ${truncate(part.summary, 200)}\n${truncate(part.output, 1500)}]`);
      }
    }
    if (message.status === 'cancelled' || message.status === 'interrupted') segments.push('[This reply was cut off before it finished.]');
    const text = segments.join('\n\n').trim() || '(no reply)';
    return { seq: message.seq, message: { role: 'assistant', text }, tokens: estimateTokens(text) };
  }

  #retrieve(conversationId: string, older: MessageDto[], query: string, tokenBudget: number): { seq: number; role: 'user' | 'assistant'; text: string }[] {
    const fts = ftsQuery(query);
    if (!fts || older.length === 0) return [];
    const olderSeqs = new Set(older.map((m) => m.seq));
    const rows = this.#db.all<{ seq: number }>(
      `SELECT m.seq FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.conversation_id = ? AND m.superseded = 0
       ORDER BY bm25(messages_fts) LIMIT 12`,
      fts,
      conversationId,
    );
    const out: { seq: number; role: 'user' | 'assistant'; text: string }[] = [];
    let used = 0;
    for (const row of rows) {
      if (!olderSeqs.has(row.seq)) continue;
      const message = older.find((m) => m.seq === row.seq)!;
      const text = truncate(message.content, 6000);
      const t = estimateTokens(text);
      if (used + t > tokenBudget) continue;
      used += t;
      out.push({ seq: message.seq, role: message.role, text });
      if (out.length >= 6) break;
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
}
