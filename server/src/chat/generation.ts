import type { ContextReport, MessageDto, MessagePart, MessageStatus, ProfileDto, SourceRef } from '../../../shared/types.ts';
import { attachmentProblem, type ContextBuilder } from '../assistants/context-builder.ts';
import { policyFor } from '../assistants/policy.ts';
import type { ProfileService } from '../assistants/profiles.ts';
import type { Db } from '../db/database.ts';
import type { ConversationService } from '../domain/conversations.ts';
import type { PreferencesService } from '../domain/preferences.ts';
import type { UsageService } from '../domain/usage.ts';
import type { EventBus } from '../events/bus.ts';
import { AppError, badRequest, conflict, errorMessage, forbidden } from '../lib/errors.ts';
import { truncate, truncateMiddle } from '../lib/text.ts';
import { estimateTokens } from '../lib/tokens.ts';
import type { SuggestionScanner } from '../memory/suggestions.ts';
import type { ConnectionService } from '../providers/connections.ts';
import { ProviderError, toMessageError } from '../providers/errors.ts';
import type { ChatMessage, ToolCall, ToolResultBlock } from '../providers/types.ts';
import type { AttachmentService } from '../tools/attachments.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { WebSearchService } from '../tools/web-search.ts';
import type { ModelRunner, ResolvedModel } from './model-runner.ts';

const MAX_TOOL_ROUNDS = 8;
const FLUSH_MS = 400;

type TextPart = Extract<MessagePart, { type: 'text' }>;
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

function displayInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) out[key] = typeof value === 'string' ? truncate(value, 2000) : value;
  return out;
}

/**
 * Runs assistant responses: persists the user's message first (so input is never lost), streams the
 * reply to every open view, executes permitted tools with approvals, and records the outcome honestly
 * (complete, stopped, or failed with a specific reason).
 */
export class GenerationService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #conversations: ConversationService;
  readonly #profiles: ProfileService;
  readonly #attachments: AttachmentService;
  readonly #runner: ModelRunner;
  readonly #contextBuilder: ContextBuilder;
  readonly #tools: ToolRegistry;
  readonly #webSearch: WebSearchService;
  readonly #usage: UsageService;
  readonly #prefs: PreferencesService;
  readonly #connections: ConnectionService;
  readonly #suggestions: SuggestionScanner;
  readonly #active = new Map<string, { controller: AbortController; conversationId: string; done: Promise<void> }>();

  constructor(deps: {
    db: Db;
    bus: EventBus;
    conversations: ConversationService;
    profiles: ProfileService;
    attachments: AttachmentService;
    runner: ModelRunner;
    contextBuilder: ContextBuilder;
    tools: ToolRegistry;
    webSearch: WebSearchService;
    usage: UsageService;
    prefs: PreferencesService;
    connections: ConnectionService;
    suggestions: SuggestionScanner;
  }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#conversations = deps.conversations;
    this.#profiles = deps.profiles;
    this.#attachments = deps.attachments;
    this.#runner = deps.runner;
    this.#contextBuilder = deps.contextBuilder;
    this.#tools = deps.tools;
    this.#webSearch = deps.webSearch;
    this.#usage = deps.usage;
    this.#prefs = deps.prefs;
    this.#connections = deps.connections;
    this.#suggestions = deps.suggestions;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  isActive(conversationId: string): boolean {
    return [...this.#active.values()].some((run) => run.conversationId === conversationId);
  }

  /** Resolves when all running responses have finished (used by tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.#active.values()].map((run) => run.done));
  }

  resolveSelection(conversationId: string): { profile: ProfileDto; modelId: string | null } {
    const conversation = this.#conversations.get(conversationId);
    const fallback =
      conversation.kind === 'master'
        ? this.#profiles.getMaster()
        : conversation.kind === 'goals'
          ? this.#profiles.getGoals(conversation.workspaceId!)
          : // In a theologian's chats, that theologian answers unless another assistant is picked.
            (conversation.workspaceId && this.#profiles.findGoals(conversation.workspaceId)) || this.#profiles.getDefaultGeneral();
    const profile = (conversation.selectedProfileId && this.#profiles.find(conversation.selectedProfileId)) || fallback;
    if (!this.#profiles.isUsableIn(profile, conversation)) throw forbidden(`${profile.name} can't be used in this conversation.`);
    return { profile, modelId: conversation.selectedModelId ?? profile.preferredModelId ?? null };
  }

  #resolveModel(profile: ProfileDto, modelId: string | null): ResolvedModel {
    if (!modelId) {
      throw new AppError(
        'no_model',
        profile.kind === 'general'
          ? 'Choose a model in the picker below the message box. (Add one in Settings → Models if the list is empty.)'
          : `Choose a model for ${profile.name} in Settings → Assistants, or pick a model in the picker below.`,
        400,
      );
    }
    return this.#runner.resolve(modelId);
  }

  async send(input: { conversationId: string; text: string; attachmentIds: string[]; originClientId?: string }): Promise<{ userMessage: MessageDto; assistantMessage: MessageDto }> {
    const conversation = this.#conversations.get(input.conversationId);
    if (this.isActive(conversation.id)) throw conflict('A response is still being written in this chat. Wait for it to finish or press Stop.');
    const text = input.text.replace(/\s+$/, '');
    if (!text.trim() && input.attachmentIds.length === 0) throw badRequest('Write a message or attach a file.');
    if (text.length > 200_000) throw badRequest('That message is over 200,000 characters. Attach it as a file instead.');

    const { profile, modelId } = this.resolveSelection(conversation.id);
    const resolved = this.#resolveModel(profile, modelId);
    const attachmentIds = [...new Set(input.attachmentIds)];
    const attachments = attachmentIds.map((id) => this.#attachments.get(id));
    const problem = attachmentProblem(attachments, resolved.model);
    if (problem) throw new AppError('attachment_unsupported', problem, 400);

    const { userMessage, assistantMessage } = this.#db.tx(() => {
      this.#attachments.assignToConversation(attachmentIds, conversation.id, conversation.workspaceId);
      const user = this.#conversations.appendMessage({ conversationId: conversation.id, role: 'user', content: text, attachmentIds });
      this.#conversations.autoTitle(conversation.id, text || attachments[0]?.filename || 'Attachment');
      const assistant = this.#conversations.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        parts: [],
        profile: { id: profile.id, name: profile.name, kind: profile.kind },
        model: { id: resolved.model.id, label: resolved.model.displayName, connectionLabel: resolved.connection.name },
        status: 'streaming',
      });
      return { userMessage: user, assistantMessage: assistant };
    });
    this.#conversations.saveDraft(conversation.id, '', [], input.originClientId);
    this.#bus.publish({ type: 'messages.changed', conversationId: conversation.id });
    this.#bus.publish({ type: 'conversations.changed', workspaceId: conversation.workspaceId, conversationId: conversation.id });
    this.#start(conversation.id, assistantMessage.id, profile, resolved);
    return { userMessage: this.#conversations.getMessage(userMessage.id), assistantMessage };
  }

  async retry(messageId: string): Promise<MessageDto> {
    const message = this.#conversations.getMessage(messageId);
    if (message.role !== 'assistant') throw badRequest('Only responses can be retried.');
    if (this.isActive(message.conversationId)) throw conflict('A response is still being written in this chat.');
    const all = this.#conversations.listMessages(message.conversationId);
    if (all.some((m) => m.seq > message.seq && !m.superseded)) throw badRequest('Only the most recent response can be retried.');
    const { profile, modelId } = this.resolveSelection(message.conversationId);
    const resolved = this.#resolveModel(profile, modelId);
    const lastUser = all.filter((m) => m.role === 'user' && m.seq < message.seq).at(-1);
    const problem = attachmentProblem(lastUser?.attachments ?? [], resolved.model);
    if (problem) throw new AppError('attachment_unsupported', problem, 400);

    const assistant = this.#db.tx(() => {
      this.#conversations.updateMessage(message.id, { superseded: true });
      return this.#conversations.appendMessage({
        conversationId: message.conversationId,
        role: 'assistant',
        parts: [],
        profile: { id: profile.id, name: profile.name, kind: profile.kind },
        model: { id: resolved.model.id, label: resolved.model.displayName, connectionLabel: resolved.connection.name },
        status: 'streaming',
      });
    });
    this.#bus.publish({ type: 'messages.changed', conversationId: message.conversationId });
    this.#start(message.conversationId, assistant.id, profile, resolved);
    return assistant;
  }

  cancel(messageId: string): boolean {
    const run = this.#active.get(messageId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  cancelConversation(conversationId: string): void {
    for (const run of this.#active.values()) if (run.conversationId === conversationId) run.controller.abort();
  }

  cancelAll(): void {
    for (const run of this.#active.values()) run.controller.abort();
  }

  #start(conversationId: string, messageId: string, profile: ProfileDto, resolved: ResolvedModel): void {
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.#active.set(messageId, { controller, conversationId, done });
    void this.#run(conversationId, messageId, profile, resolved, controller.signal).finally(() => {
      this.#active.delete(messageId);
      resolveDone();
    });
  }

  async #run(conversationId: string, messageId: string, profile: ProfileDto, resolved: ResolvedModel, signal: AbortSignal): Promise<void> {
    const parts: MessagePart[] = [];
    let status: MessageStatus = 'streaming';
    let textPart: TextPart | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let report: ContextReport | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageKnown = true;
    let producedText = '';
    const conversation = this.#conversations.get(conversationId);

    const persist = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      this.#conversations.updateMessage(messageId, { parts, status });
    };
    const publishParts = (): void => {
      persist();
      this.#bus.publish({ type: 'message.parts', conversationId, messageId, parts, status });
    };
    const appendText = (text: string): void => {
      if (!textPart) {
        textPart = { type: 'text', text: '' };
        parts.push(textPart);
        publishParts();
      }
      const offset = textPart.text.length;
      textPart.text += text;
      producedText += text;
      this.#bus.publish({ type: 'message.delta', conversationId, messageId, partIndex: parts.indexOf(textPart), offset, text });
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        persist();
      }, FLUSH_MS);
    };
    const notice = (level: 'info' | 'warning', text: string): void => {
      parts.push({ type: 'notice', level, text });
      publishParts();
    };

    try {
      const own = this.#conversations.getMessage(messageId);
      const history = this.#conversations.listMessages(conversationId).filter((m) => m.seq < own.seq);
      const tools = await this.#tools.forRequest({ conversation, profile, model: resolved.model });
      const policyAllowsSearch = policyFor(profile.kind).allowedToolGroups.includes('web_search') && profile.tools.includes('web_search');

      let preSearch: { query: string; results: SourceRef[] } | null = null;
      if (conversation.webSearchEnabled && policyAllowsSearch) {
        const ready = await this.#webSearch.isReady();
        if (!ready) {
          notice('warning', "Web search is on for this chat, but no search API key is set up (Settings → Tools), so this reply didn't search the web.");
        } else if (!resolved.model.supportsTools) {
          // Models without tool support: the app searches once with the user's message and shares the results.
          const query = truncate(history.filter((m) => m.role === 'user').at(-1)?.content.trim() ?? '', 300);
          if (query) {
            const callId = `app_search_${messageId.slice(0, 8)}`;
            const call: ToolCallPart = { type: 'tool_call', id: callId, name: 'web_search', input: { query }, status: 'running' };
            parts.push(call);
            publishParts();
            try {
              const results = await this.#webSearch.search(query, 5, signal);
              preSearch = { query, results };
              call.status = 'done';
              parts.push({
                type: 'tool_result',
                callId,
                name: 'web_search',
                summary: `${results.length} result${results.length === 1 ? '' : 's'} (searched by the app — this model doesn't call tools)`,
                output: results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}`).join('\n'),
                isError: false,
                sources: results,
              });
            } catch (err) {
              if (signal.aborted) throw err;
              call.status = 'error';
              parts.push({ type: 'tool_result', callId, name: 'web_search', summary: 'Search failed', output: errorMessage(err), isError: true });
            }
            publishParts();
          }
        }
      }
      if (conversation.filesEnabled && conversation.kind === 'chat' && profile.tools.includes('files')) {
        if (!resolved.model.supportsTools) notice('info', `File tools are on, but ${resolved.model.displayName} isn't set up for tool use, so it can't read or edit files.`);
        else if (!tools.scope) notice('warning', 'File tools are on, but no valid working folder is set for this mission.');
      }

      const maxOutputTokens = resolved.model.maxOutputTokens;
      const built = await this.#contextBuilder.build({
        conversation,
        history,
        profile,
        resolved,
        maxOutputTokens,
        toolNames: tools.names,
        workingFolder: tools.scope?.root ?? null,
        preSearch,
        signal,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      report = built.report;
      this.#conversations.updateMessage(messageId, { context: report });

      const messages: ChatMessage[] = [...built.messages];
      for (let round = 1; ; round++) {
        textPart = null;
        let roundText = '';
        const calls: ToolCall[] = [];
        let providerState;
        for await (const event of this.#runner.stream({ resolved, system: built.system, messages, tools: tools.specs, maxOutputTokens, signal })) {
          if (event.type === 'text') {
            roundText += event.text;
            appendText(event.text);
          } else if (event.type === 'tool_call') {
            calls.push(event.call);
          } else if (event.type === 'usage') {
            if (event.inputTokens === null && event.outputTokens === null) usageKnown = false;
            inputTokens += event.inputTokens ?? 0;
            outputTokens += event.outputTokens ?? 0;
          } else if (event.type === 'done') {
            providerState = event.providerState;
            if (event.notice) notice('warning', event.notice);
            if (event.stopReason === 'max_tokens') {
              notice('warning', `This reply reached the ${maxOutputTokens.toLocaleString()}-token output limit set for ${resolved.model.displayName} and may be incomplete.`);
            }
          }
        }
        if (calls.length === 0) break;
        if (round > MAX_TOOL_ROUNDS) {
          notice('warning', `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool use. Ask to continue if needed.`);
          break;
        }
        messages.push({ role: 'assistant', text: roundText, toolCalls: calls, providerState });
        const results: ToolResultBlock[] = [];
        for (const call of calls) {
          const callPart: ToolCallPart = { type: 'tool_call', id: call.id, name: call.name, input: displayInput(call.input), status: 'running' };
          textPart = null;
          parts.push(callPart);
          publishParts();
          const outcome = await this.#tools.execute(call, tools, {
            conversation,
            profile,
            messageId,
            toolCallId: call.id,
            signal,
            setAwaitingApproval: (approvalId) => {
              if (approvalId) {
                callPart.status = 'awaiting_approval';
                callPart.approvalId = approvalId;
                status = 'awaiting_approval';
              } else {
                callPart.status = 'running';
                status = 'streaming';
              }
              publishParts();
            },
          });
          callPart.status = outcome.denied ? 'denied' : outcome.isError ? 'error' : 'done';
          parts.push({
            type: 'tool_result',
            callId: call.id,
            name: call.name,
            summary: outcome.summary,
            output: truncate(outcome.output, 8000),
            isError: outcome.isError,
            sources: outcome.sources,
            diff: outcome.diff,
          });
          publishParts();
          results.push({ toolCallId: call.id, name: call.name, content: truncateMiddle(outcome.output, 20_000), isError: outcome.isError });
          if (signal.aborted) break;
        }
        if (signal.aborted) throw new ProviderError('cancelled', 'Stopped.');
        messages.push({ role: 'tool', results });
      }

      status = 'complete';
      this.#conversations.updateMessage(messageId, {
        parts,
        status,
        error: null,
        usage: { inputTokens: usageKnown ? inputTokens : null, outputTokens: usageKnown ? outputTokens : null, estimated: !usageKnown },
        context: report,
      });
      this.#bus.publish({ type: 'message.parts', conversationId, messageId, parts, status });
      this.#connections.noteRequestSuccess(resolved.connection.id, resolved.model.displayName);
      this.#usage.record({
        purpose: 'chat',
        workspaceId: conversation.workspaceId,
        conversationId,
        modelId: resolved.model.id,
        modelLabel: resolved.model.displayName,
        inputTokens: usageKnown ? inputTokens : report.estimatedTokens,
        outputTokens: usageKnown ? outputTokens : estimateTokens(producedText),
        estimated: !usageKnown,
        status: 'ok',
      });
      if (conversation.workspaceId && conversation.kind !== 'master') this.#suggestions.schedule(conversationId);
    } catch (err) {
      const cancelled = signal.aborted || (err instanceof ProviderError && err.kind === 'cancelled');
      status = cancelled ? 'cancelled' : 'error';
      for (const part of parts) {
        if (part.type === 'tool_call' && (part.status === 'running' || part.status === 'awaiting_approval')) part.status = 'cancelled';
      }
      const error = cancelled ? null : toMessageError(err, resolved.connection.id);
      if (error && (error.code === 'message_too_long' || error.code === 'context_too_small')) error.action = 'choose_model';
      this.#conversations.updateMessage(messageId, { parts, status, error, context: report });
      this.#bus.publish({ type: 'message.parts', conversationId, messageId, parts, status });
      this.#usage.record({
        purpose: 'chat',
        workspaceId: conversation.workspaceId,
        conversationId,
        modelId: resolved.model.id,
        modelLabel: resolved.model.displayName,
        inputTokens: inputTokens || null,
        outputTokens: outputTokens || null,
        status: cancelled ? 'cancelled' : 'error',
        detail: cancelled ? 'Stopped' : truncate(errorMessage(err), 200),
      });
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      this.#bus.publish({ type: 'messages.changed', conversationId });
      this.#bus.publish({ type: 'conversations.changed', workspaceId: conversation.workspaceId, conversationId });
    }
  }
}
