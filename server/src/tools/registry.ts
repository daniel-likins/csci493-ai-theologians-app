import { MEMORY_CATEGORY_IDS, MEMORY_CERTAINTY_IDS } from '../../../shared/constants.ts';
import type { ApprovalKind, ConversationDto, ModelDto, ProfileDto, SourceRef, ToolGroup } from '../../../shared/types.ts';
import { policyFor } from '../assistants/policy.ts';
import type { ConversationService } from '../domain/conversations.ts';
import type { PreferencesService } from '../domain/preferences.ts';
import type { WorkspaceService } from '../domain/workspaces.ts';
import { errorMessage } from '../lib/errors.ts';
import { truncate } from '../lib/text.ts';
import type { MemoryService } from '../memory/memory-service.ts';
import type { ToolCall, ToolSpec } from '../providers/types.ts';
import type { ApprovalService } from './approvals.ts';
import type { AttachmentService } from './attachments.ts';
import { formatCommandResult, runSandboxedCommand, sandboxAvailable } from './exec.ts';
import { applyEdit, FileScope, listDirectory, prepareEdit, readTextFile, searchFiles, validateWorkingFolder } from './files.ts';
import type { WebSearchService } from './web-search.ts';

export interface ToolSettings {
  commandNetwork: boolean;
  commandTimeoutSeconds: number;
  outsideFolderAccess: 'ask' | 'deny';
}

export interface ToolExecutionContext {
  conversation: ConversationDto;
  profile: ProfileDto;
  messageId: string;
  toolCallId: string;
  signal: AbortSignal;
  /** Show (id) or clear (null) the "waiting for your approval" state on the message. */
  setAwaitingApproval: (approvalId: string | null) => void;
}

export interface ToolOutcome {
  output: string;
  summary: string;
  isError: boolean;
  denied?: boolean;
  sources?: SourceRef[];
  diff?: string;
}

export interface RequestTools {
  specs: ToolSpec[];
  names: string[];
  scope: FileScope | null;
  attachmentIds: string[];
  settings: ToolSettings;
}

interface ToolDefinition {
  name: string;
  group: ToolGroup;
  spec: (env: RequestTools) => ToolSpec;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext, env: RequestTools) => Promise<ToolOutcome>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

function fail(summary: string, output = summary): ToolOutcome {
  return { output, summary, isError: true };
}

export class ToolRegistry {
  readonly #prefs: PreferencesService;
  readonly #webSearch: WebSearchService;
  readonly #attachments: AttachmentService;
  readonly #memory: MemoryService;
  readonly #conversations: ConversationService;
  readonly #approvals: ApprovalService;
  readonly #workspaces: WorkspaceService;
  readonly #dataDir: string;
  readonly #definitions: ToolDefinition[];

  constructor(deps: {
    prefs: PreferencesService;
    webSearch: WebSearchService;
    attachments: AttachmentService;
    memory: MemoryService;
    conversations: ConversationService;
    approvals: ApprovalService;
    workspaces: WorkspaceService;
    dataDir: string;
  }) {
    this.#prefs = deps.prefs;
    this.#webSearch = deps.webSearch;
    this.#attachments = deps.attachments;
    this.#memory = deps.memory;
    this.#conversations = deps.conversations;
    this.#approvals = deps.approvals;
    this.#workspaces = deps.workspaces;
    this.#dataDir = deps.dataDir;
    this.#definitions = this.#buildDefinitions();
  }

  settings(): ToolSettings {
    const access = this.#prefs.get<string>('tools.outsideFolderAccess', 'ask');
    return {
      commandNetwork: this.#prefs.get<boolean>('tools.commandNetwork', false),
      commandTimeoutSeconds: Math.max(5, Math.min(600, this.#prefs.get<number>('tools.commandTimeoutSeconds', 60))),
      outsideFolderAccess: access === 'deny' ? 'deny' : 'ask',
    };
  }

  /**
   * Tools offered for one request = policy for the assistant kind ∩ the profile's enabled tools ∩ this
   * conversation's toggles ∩ configured services ∩ the model's declared tool support.
   */
  async forRequest(args: { conversation: ConversationDto; profile: ProfileDto; model: ModelDto }): Promise<RequestTools> {
    const { conversation, profile, model } = args;
    const settings = this.settings();
    const attachmentIds = this.#conversationAttachmentIds(conversation.id);
    const empty: RequestTools = { specs: [], names: [], scope: null, attachmentIds, settings };
    if (!model.supportsTools) return empty;

    const allowed = new Set(policyFor(profile.kind).allowedToolGroups);
    const enabled = new Set(profile.tools.filter((g) => allowed.has(g)));
    const workspaceSettings = conversation.workspaceId ? this.#workspaces.getSettings(conversation.workspaceId) : null;

    let scope: FileScope | null = null;
    if ((enabled.has('files') || enabled.has('run_command')) && conversation.filesEnabled && workspaceSettings?.workingFolder) {
      try {
        scope = new FileScope(await validateWorkingFolder(workspaceSettings.workingFolder, this.#dataDir), this.#dataDir);
      } catch {
        scope = null;
      }
    }
    const webReady = enabled.has('web_search') && conversation.webSearchEnabled && (await this.#webSearch.isReady());
    const env: RequestTools = { specs: [], names: [], scope, attachmentIds, settings };

    for (const def of this.#definitions) {
      if (!enabled.has(def.group)) continue;
      const available =
        def.group === 'web_search'
          ? webReady
          : def.group === 'attachments'
            ? attachmentIds.length > 0
            : def.group === 'files'
              ? scope !== null
              : def.group === 'run_command'
                ? scope !== null && sandboxAvailable()
                : def.group === 'mission_history'
                  ? profile.kind === 'goals' && conversation.workspaceId !== null && workspaceSettings?.historyAccess === 'search'
                  : def.group === 'memory_proposals'
                    ? profile.kind === 'goals' && conversation.kind !== 'master' && profile.workspaceId === conversation.workspaceId
                    : false;
      if (!available) continue;
      env.names.push(def.name);
      env.specs.push(def.spec(env));
    }
    return env;
  }

  async execute(call: ToolCall, env: RequestTools, ctx: ToolExecutionContext): Promise<ToolOutcome> {
    const def = this.#definitions.find((d) => d.name === call.name);
    if (!def || !env.names.includes(call.name)) {
      return fail(`Tool not available`, `The tool “${call.name}” is not available in this conversation.`);
    }
    // Defense in depth: policy is checked again at execution time.
    if (!policyFor(ctx.profile.kind).allowedToolGroups.includes(def.group)) {
      return fail('Not permitted', `${ctx.profile.name} is not permitted to use ${call.name}.`);
    }
    if ('__invalid_arguments' in call.input) {
      return fail('Invalid arguments', `The arguments for ${call.name} were not valid JSON. Try again with valid JSON arguments.`);
    }
    try {
      return await def.execute(call.input, ctx, env);
    } catch (err) {
      if (ctx.signal.aborted) return { output: 'Cancelled by the user.', summary: 'Cancelled', isError: true };
      return fail(truncate(errorMessage(err), 160), errorMessage(err));
    }
  }

  #conversationAttachmentIds(conversationId: string): string[] {
    return this.#conversations
      .listMessages(conversationId)
      .flatMap((m) => m.attachments)
      .filter((a) => a.kind === 'pdf' || a.kind === 'text')
      .filter((a) => a.extractionStatus === 'ok' || a.extractionStatus === 'partial')
      .map((a) => a.id);
  }

  async #approve(ctx: ToolExecutionContext, kind: ApprovalKind, payload: Record<string, unknown>): Promise<string> {
    try {
      return await this.#approvals.request(
        { conversationId: ctx.conversation.id, messageId: ctx.messageId, toolCallId: ctx.toolCallId, kind, payload },
        ctx.signal,
        (id) => ctx.setAwaitingApproval(id),
      );
    } finally {
      ctx.setAwaitingApproval(null);
    }
  }

  async #resolveReadable(ctx: ToolExecutionContext, env: RequestTools, inputPath: string, purpose: string): Promise<{ abs: string; label: string } | ToolOutcome> {
    const scope = env.scope!;
    const target = await scope.resolve(inputPath);
    scope.assertNotSensitive(target.abs);
    if (target.inside) return { abs: target.abs, label: target.rel };
    if (env.settings.outsideFolderAccess === 'deny') {
      return fail('Outside the working folder', `“${target.abs}” is outside the working folder, and access outside it is turned off in Settings.`);
    }
    const decision = await this.#approve(ctx, 'read_outside_folder', { path: target.abs, purpose });
    if (decision !== 'approved') {
      return { output: `The user did not allow access to “${target.abs}”.`, summary: 'Access declined', isError: true, denied: true };
    }
    return { abs: target.abs, label: target.abs };
  }

  #buildDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'web_search',
        group: 'web_search',
        spec: () => ({
          name: 'web_search',
          description: 'Search the web for current or specific information. Returns numbered results with title, URL, and snippet.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search query.' },
              max_results: { type: 'integer', description: 'Number of results, 1–8 (default 5).' },
            },
            required: ['query'],
          },
        }),
        execute: async (input, ctx) => {
          const query = str(input.query)?.trim();
          if (!query) return fail('Missing query', 'Provide a search query.');
          const results = await this.#webSearch.search(query.slice(0, 400), int(input.max_results) ?? 5, ctx.signal);
          const output = results.length
            ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet ?? ''}`).join('\n\n')
            : 'No results.';
          return { output, summary: `${results.length} result${results.length === 1 ? '' : 's'} for “${truncate(query, 80)}”`, isError: false, sources: results };
        },
      },
      {
        name: 'read_attachment',
        group: 'attachments',
        spec: (env) => ({
          name: 'read_attachment',
          description: `Read text from a file attached in this conversation. Use page for a specific PDF page, or query to find the most relevant parts. Attachments: ${env.attachmentIds
            .map((id) => {
              const a = this.#attachments.get(id);
              return `${id} (${a.filename}${a.pageCount ? `, ${a.pageCount} pages` : ''})`;
            })
            .join('; ')}`,
          parameters: {
            type: 'object',
            properties: {
              attachment_id: { type: 'string', description: 'The attachment id.' },
              page: { type: 'integer', description: 'A PDF page number to read.' },
              query: { type: 'string', description: 'What to look for.' },
            },
            required: ['attachment_id'],
          },
        }),
        execute: async (input, _ctx, env) => {
          const id = str(input.attachment_id);
          if (!id || !env.attachmentIds.includes(id)) return fail('Unknown attachment', 'That attachment id is not part of this conversation.');
          const page = int(input.page);
          const query = str(input.query);
          const chunks = page ? this.#attachments.chunksForPage(id, page) : query ? this.#attachments.search([id], query, 5) : this.#attachments.chunks(id).slice(0, 3);
          if (chunks.length === 0) return fail('Nothing found', page ? `Page ${page} has no extractable text.` : 'No matching text was found.');
          const filename = chunks[0]!.filename;
          const output = truncate(chunks.map((c) => c.text).join('\n\n'), 24_000);
          const where = page ? `page ${page}` : query ? `“${truncate(query, 40)}”` : 'beginning';
          return { output: `${filename}:\n${output}`, summary: `Read ${filename} (${where})`, isError: false };
        },
      },
      {
        name: 'list_files',
        group: 'files',
        spec: () => ({
          name: 'list_files',
          description: 'List files and folders in the working folder (or a subfolder).',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path relative to the working folder. Default ".".' } } },
        }),
        execute: async (input, ctx, env) => {
          const target = await this.#resolveReadable(ctx, env, str(input.path) || '.', 'list a folder');
          if ('isError' in target) return target;
          return { output: await listDirectory(target.abs, target.label), summary: `Listed ${target.label}`, isError: false };
        },
      },
      {
        name: 'read_file',
        group: 'files',
        spec: () => ({
          name: 'read_file',
          description: 'Read a text file with line numbers. Use start_line and end_line for large files.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the working folder.' },
              start_line: { type: 'integer', description: 'First line (1-based).' },
              end_line: { type: 'integer', description: 'Last line (inclusive).' },
            },
            required: ['path'],
          },
        }),
        execute: async (input, ctx, env) => {
          const p = str(input.path);
          if (!p) return fail('Missing path', 'Provide a file path.');
          const target = await this.#resolveReadable(ctx, env, p, 'read a file');
          if ('isError' in target) return target;
          const output = await readTextFile(target.abs, target.label, int(input.start_line), int(input.end_line));
          return { output, summary: `Read ${target.label}`, isError: false };
        },
      },
      {
        name: 'search_files',
        group: 'files',
        spec: () => ({
          name: 'search_files',
          description: 'Search text files in the working folder for a string (case-insensitive). Skips node_modules, .git, and build folders.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Text to search for.' },
              path: { type: 'string', description: 'Subfolder to search, relative to the working folder.' },
            },
            required: ['query'],
          },
        }),
        execute: async (input, _ctx, env) => {
          const scope = env.scope!;
          const query = str(input.query);
          if (!query) return fail('Missing query', 'Provide text to search for.');
          const target = await scope.resolve(str(input.path) || '.');
          if (!target.inside) return fail('Outside the working folder', 'Search is limited to the working folder.');
          return { output: await searchFiles(scope.root, target.abs, query), summary: `Searched for “${truncate(query, 60)}”`, isError: false };
        },
      },
      {
        name: 'propose_file_edit',
        group: 'files',
        spec: () => ({
          name: 'propose_file_edit',
          description:
            'Propose creating or changing a file in the working folder. Either give new_content (the whole file), or find + replace for a single exact replacement. The user reviews the diff and must approve before anything is written.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the working folder.' },
              new_content: { type: 'string', description: 'Full new file content.' },
              find: { type: 'string', description: 'Exact existing text to replace (must match once).' },
              replace: { type: 'string', description: 'Replacement text.' },
              summary: { type: 'string', description: 'One sentence describing the change.' },
            },
            required: ['path'],
          },
        }),
        execute: async (input, ctx, env) => {
          const scope = env.scope!;
          const p = str(input.path);
          if (!p) return fail('Missing path', 'Provide a file path.');
          const proposal = await prepareEdit(scope, p, { newContent: str(input.new_content), find: str(input.find), replace: str(input.replace) });
          const decision = await this.#approve(ctx, 'apply_file_edit', {
            path: proposal.rel,
            isNew: proposal.isNew,
            diff: proposal.diff,
            summary: truncate(str(input.summary) ?? '', 300),
          });
          if (decision !== 'approved') {
            const why = decision === 'denied' ? 'The user declined this edit' : decision === 'expired' ? 'Nobody approved the edit in time' : 'The response was stopped';
            return { output: `${why}. Nothing was written to ${proposal.rel}.`, summary: `Edit not applied (${decision})`, isError: true, denied: true, diff: proposal.diff };
          }
          await applyEdit(scope, proposal);
          return { output: `${proposal.isNew ? 'Created' : 'Updated'} ${proposal.rel}.`, summary: `${proposal.isNew ? 'Created' : 'Edited'} ${proposal.rel}`, isError: false, diff: proposal.diff };
        },
      },
      {
        name: 'run_command',
        group: 'run_command',
        spec: (env) => ({
          name: 'run_command',
          description: `Run a shell command inside the working folder, in an operating-system sandbox (${env.settings.commandNetwork ? 'network allowed' : 'no network'}; writes only inside the working folder). The user must approve each command. Default timeout ${env.settings.commandTimeoutSeconds} s.`,
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The shell command to run.' },
              cwd: { type: 'string', description: 'Subfolder to run in, relative to the working folder.' },
              timeout_seconds: { type: 'integer', description: 'Timeout in seconds.' },
            },
            required: ['command'],
          },
        }),
        execute: async (input, ctx, env) => {
          const scope = env.scope!;
          const command = str(input.command)?.trim();
          if (!command) return fail('Missing command', 'Provide a command.');
          if (command.length > 4000) return fail('Command too long', 'Commands can be at most 4,000 characters.');
          const cwd = await scope.resolve(str(input.cwd) || '.');
          if (!cwd.inside || !cwd.exists) return fail('Invalid folder', 'Commands can only run inside the working folder.');
          const timeoutSeconds = Math.max(1, Math.min(env.settings.commandTimeoutSeconds, int(input.timeout_seconds) ?? env.settings.commandTimeoutSeconds));
          const decision = await this.#approve(ctx, 'run_command', {
            command,
            cwd: cwd.rel,
            timeoutSeconds,
            network: env.settings.commandNetwork,
          });
          if (decision !== 'approved') {
            const why = decision === 'denied' ? 'The user declined to run this command' : decision === 'expired' ? 'Nobody approved the command in time' : 'The response was stopped';
            return { output: `${why}. It was not run.`, summary: `Not run (${decision})`, isError: true, denied: true };
          }
          const result = await runSandboxedCommand({
            command,
            cwd: cwd.abs,
            root: scope.root,
            timeoutMs: timeoutSeconds * 1000,
            allowNetwork: env.settings.commandNetwork,
            dataDir: this.#dataDir,
            signal: ctx.signal,
          });
          const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
          return {
            output: formatCommandResult(command, cwd.rel, result),
            summary: result.timedOut ? 'Timed out' : result.cancelled ? 'Cancelled' : `Exit code ${result.exitCode}`,
            isError: !ok,
          };
        },
      },
      {
        name: 'search_mission_chats',
        group: 'mission_history',
        spec: () => ({
          name: 'search_mission_chats',
          description: "Search past conversations in this mission (not other missions). Returns titles, dates, and matching excerpts.",
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' } }, required: ['query'] },
        }),
        execute: async (input, ctx) => {
          const query = str(input.query)?.trim();
          if (!query) return fail('Missing query', 'Provide something to search for.');
          const workspaceId = ctx.conversation.workspaceId;
          if (!workspaceId) return fail('Not available', 'There is no mission to search.');
          const hits = this.#conversations.search(workspaceId, ['chat', 'goals'], query, 10).filter((h) => h.conversationId !== ctx.conversation.id).slice(0, 8);
          if (hits.length === 0) return { output: `No past conversations in this mission matched “${query}”.`, summary: 'No matches', isError: false };
          const output = hits
            .map((h) => {
              const summary = this.#conversations.internals(h.conversationId).summaryText;
              return `• “${h.title}” (last active ${h.updatedAt.slice(0, 10)})${h.snippet ? `\n  …${h.snippet.replace(/[«»]/g, '')}…` : ''}${summary ? `\n  Summary: ${truncate(summary, 500)}` : ''}`;
            })
            .join('\n');
          return { output, summary: `${hits.length} related conversation${hits.length === 1 ? '' : 's'}`, isError: false };
        },
      },
      {
        name: 'propose_memory_update',
        group: 'memory_proposals',
        spec: () => ({
          name: 'propose_memory_update',
          description:
            "Suggest one important change to this mission's saved memory. Use target_id (from the saved memory list) to update or remove an existing item. Only for durable, important points — never to save a whole conversation.",
          parameters: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add', 'update', 'remove'], description: 'Add a new item, update an item, or remove an item.' },
              target_id: { type: 'string', description: 'Id of the saved item to update or remove.' },
              category: { type: 'string', enum: [...MEMORY_CATEGORY_IDS], description: 'Memory category.' },
              certainty: {
                type: 'string',
                enum: [...MEMORY_CERTAINTY_IDS],
                description: 'confirmed = the user stated or decided it; tentative = the user is considering it; suggestion = your idea the user has not adopted.',
              },
              text: { type: 'string', description: 'The memory item, one short sentence about the user.' },
              importance: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How important this is to remember.' },
              reason: { type: 'string', description: 'Why this should be remembered.' },
              evidence: { type: 'string', description: "For confirmed items, the user's own words from this conversation." },
            },
            required: ['op', 'reason'],
          },
        }),
        execute: async (input, ctx) => {
          const workspaceId = ctx.conversation.workspaceId;
          if (!workspaceId) return fail('Not permitted', 'Memory can only be changed inside a mission.');
          const proposal = this.#memory.propose(
            { kind: 'goals_assistant', profileId: ctx.profile.id, conversationId: ctx.conversation.id },
            workspaceId,
            {
              op: str(input.op) as 'add' | 'update' | 'remove',
              targetItemId: str(input.target_id) ?? null,
              category: (str(input.category) ?? null) as never,
              certainty: (str(input.certainty) ?? null) as never,
              text: str(input.text) ?? null,
              importance: (str(input.importance) ?? null) as never,
              reason: str(input.reason) ?? null,
              evidence: str(input.evidence) ?? null,
              sourceMessageId: ctx.messageId,
            },
          );
          const what = proposal.text ?? proposal.targetText ?? '';
          if (proposal.status === 'auto_applied') {
            return { output: `Saved automatically because autosave is on: “${what}”. The user can review or undo it.`, summary: `Saved to memory (autosave): ${truncate(what, 80)}`, isError: false };
          }
          if (proposal.status === 'duplicate') {
            return { output: `Not added: ${proposal.statusDetail ?? 'already saved'}.`, summary: 'Already in memory', isError: false };
          }
          return {
            output: `Suggested — waiting for the user's approval, not saved yet: “${what}”.${proposal.statusDetail ? ` (${proposal.statusDetail})` : ''}`,
            summary: `Suggested a memory update: ${truncate(what, 80)}`,
            isError: false,
          };
        },
      },
    ];
  }
}
