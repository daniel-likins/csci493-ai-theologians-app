import {
  AlertTriangle,
  ArrowDown,
  Bookmark,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  History,
  Info,
  Loader2,
  Paperclip,
  Pencil,
  RotateCcw,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContextReport, MessageDto, MessagePart, SourceRef, ToolApprovalDto } from '../../../shared/types.ts';
import { sessionToken } from '../api/client.ts';
import { formatDateTime, formatTokens, hostOf, plural } from '../lib/format.ts';
import { navigate, paths } from '../lib/router.ts';
import { CopyButton, Markdown } from './Markdown.tsx';
import { Popover, usePopover } from './Menu.tsx';
import { Button, cx, IconButton } from './ui.tsx';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

const TOOL_META: Record<string, { label: string; icon: ReactNode }> = {
  web_search: { label: 'Web search', icon: <Globe size={14} /> },
  read_attachment: { label: 'Read attachment', icon: <BookOpen size={14} /> },
  list_files: { label: 'Listed files', icon: <FolderOpen size={14} /> },
  read_file: { label: 'Read file', icon: <FileText size={14} /> },
  search_files: { label: 'Searched files', icon: <Search size={14} /> },
  propose_file_edit: { label: 'File edit', icon: <Pencil size={14} /> },
  run_command: { label: 'Command', icon: <Terminal size={14} /> },
  search_mission_chats: { label: 'Past conversations', icon: <History size={14} /> },
  propose_memory_update: { label: 'Memory suggestion', icon: <Bookmark size={14} /> },
};

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => !/^(Index:|={5,}|--- |\+\+\+ )/.test(l));
  return (
    <div className="diff" role="region" aria-label="Proposed changes">
      {lines.map((line, i) => (
        <div key={i} className={cx('line', line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '')}>
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

function ToolCard({ call, result }: { call: ToolCallPart; result: ToolResultPart | undefined }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: <Terminal size={14} /> };
  const status =
    call.status === 'running' ? (
      <Loader2 size={14} className="spin" aria-label="Running" />
    ) : call.status === 'awaiting_approval' ? (
      <span className="tool-status waiting">Waiting for approval</span>
    ) : call.status === 'done' ? (
      <Check size={14} aria-label="Done" className="ok" />
    ) : call.status === 'denied' ? (
      <span className="tool-status">Not approved</span>
    ) : (
      <X size={14} aria-label={call.status === 'cancelled' ? 'Cancelled' : 'Failed'} className="bad" />
    );
  const summary =
    result?.summary ??
    (typeof (call.input as { query?: string }).query === 'string'
      ? `“${(call.input as { query: string }).query}”`
      : typeof (call.input as { path?: string }).path === 'string'
        ? (call.input as { path: string }).path
        : typeof (call.input as { command?: string }).command === 'string'
          ? (call.input as { command: string }).command
          : '');
  return (
    <div className={cx('tool', result?.isError && call.status !== 'denied' && 'tool-error')}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={cx('chev', open && 'open')} aria-hidden="true" />
        <span className="tool-icon" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="tool-label">{meta.label}</span>
        <span className="tool-summary truncate">{summary}</span>
        {status}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">Input</div>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {result?.diff && <DiffView diff={result.diff} />}
          {result && (
            <>
              <div className="tool-section-label">Result</div>
              <pre>{result.output}</pre>
            </>
          )}
          {call.name === 'propose_memory_update' && (
            <Button size="sm" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('theologians:open-goals', { detail: { tab: 'updates' } }))}>
              Review memory updates
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ approval, onDecide }: { approval: ToolApprovalDto; onDecide: (id: string, decision: 'approved' | 'denied') => void }) {
  const p = approval.payload as Record<string, unknown>;
  const [busy, setBusy] = useState(false);
  const decide = (decision: 'approved' | 'denied'): void => {
    setBusy(true);
    onDecide(approval.id, decision);
  };
  let title: string;
  let body: ReactNode;
  if (approval.kind === 'run_command') {
    title = 'Run this command?';
    body = (
      <>
        <pre className="approval-code">{String(p.command)}</pre>
        <div className="approval-meta">
          Runs in <code>{String(p.cwd)}</code> inside an OS sandbox · {p.network ? 'network allowed' : 'no network access'} · writes limited to the working folder · stops after {String(p.timeoutSeconds)} s
        </div>
      </>
    );
  } else if (approval.kind === 'apply_file_edit') {
    title = `${p.isNew ? 'Create' : 'Change'} ${String(p.path)}?`;
    body = (
      <>
        {typeof p.summary === 'string' && p.summary && <div className="approval-meta">{p.summary}</div>}
        <DiffView diff={String(p.diff ?? '')} />
      </>
    );
  } else {
    title = 'Allow reading outside the working folder?';
    body = (
      <div className="approval-meta">
        The assistant wants to {String(p.purpose ?? 'read')}: <code>{String(p.path)}</code>
      </div>
    );
  }
  return (
    <div className="approval" role="group" aria-label={title}>
      <div className="approval-title">
        <AlertTriangle size={15} aria-hidden="true" />
        {title}
      </div>
      {body}
      <div className="approval-actions">
        <Button size="sm" disabled={busy} onClick={() => decide('denied')}>
          Don't allow
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide('approved')}>
          {approval.kind === 'run_command' ? 'Run' : approval.kind === 'apply_file_edit' ? 'Apply change' : 'Allow once'}
        </Button>
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="sources" aria-label="Sources">
      <span className="sources-label">Sources</span>
      {sources.map((s, i) => (
        <a key={`${s.url}-${i}`} className="source" href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.title}\n${s.url}\nRetrieved via ${s.provider}`}>
          <span className="n">{i + 1}</span>
          <span className="truncate">{s.title}</span>
          <span className="host">{hostOf(s.url)}</span>
        </a>
      ))}
    </div>
  );
}

function ContextInfo({ report }: { report: ContextReport }) {
  const { open, close, toggle, anchorRef } = usePopover();
  const memoryText = { none: 'none', brief: 'theologian description only', mission: "this theologian's saved memory", all_missions: "all theologians' saved memory (read-only)" }[report.memoryIncluded];
  return (
    <>
      <IconButton ref={anchorRef} size="sm" label="What was sent to the model" onClick={toggle} aria-expanded={open}>
        <Info size={14} />
      </IconButton>
      <Popover open={open} onClose={close} anchorRef={anchorRef} placement="top-start" className="context-popover" label="Context details">
        <div className="context-info">
          <div className="context-title">What the model received</div>
          <dl>
            <dt>Estimated size</dt>
            <dd>
              ~{formatTokens(report.estimatedTokens)} of {formatTokens(report.budgetTokens)} tokens (estimate)
            </dd>
            <dt>Messages</dt>
            <dd>
              {report.includedMessages} of {plural(report.totalMessages, 'message')} sent in full
            </dd>
            {report.summaryThroughSeq !== null && (
              <>
                <dt>Summary</dt>
                <dd>Messages 1–{report.summaryThroughSeq} as a summary</dd>
              </>
            )}
            {report.retrievedSeqs.length > 0 && (
              <>
                <dt>Retrieved</dt>
                <dd>Earlier messages {report.retrievedSeqs.join(', ')}</dd>
              </>
            )}
            <dt>Memory</dt>
            <dd>{memoryText}</dd>
          </dl>
          {report.notices.map((n, i) => (
            <p key={i} className="context-notice">
              {n}
            </p>
          ))}
        </div>
      </Popover>
    </>
  );
}

function Attachments({ message }: { message: MessageDto }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (message.attachments.some((a) => a.kind === 'image')) void sessionToken().then(setToken);
  }, [message.attachments]);
  if (message.attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {message.attachments.map((a) =>
        a.kind === 'image' && token ? (
          <a key={a.id} href={`/api/attachments/${a.id}/content?token=${encodeURIComponent(token)}`} target="_blank" rel="noopener noreferrer" className="image-attachment">
            <img src={`/api/attachments/${a.id}/content?token=${encodeURIComponent(token)}`} alt={a.filename} />
          </a>
        ) : (
          <span key={a.id} className="chip" title={a.extractionDetail ?? a.filename}>
            <Paperclip size={13} aria-hidden="true" />
            <span className="truncate">{a.filename}</span>
            {a.pageCount ? <span className="muted">{a.pageCount} pp</span> : null}
            {(a.extractionStatus === 'no_text' || a.extractionStatus === 'partial') && <AlertTriangle size={13} className="warn" aria-label={a.extractionDetail ?? 'Partially readable'} />}
          </span>
        ),
      )}
    </div>
  );
}

function AssistantMessage({
  message,
  approvals,
  isLast,
  canRetry,
  onRetry,
  onDecide,
}: {
  message: MessageDto;
  approvals: ToolApprovalDto[];
  isLast: boolean;
  canRetry: boolean;
  onRetry: (id: string) => void;
  onDecide: (id: string, decision: 'approved' | 'denied') => void;
}) {
  const results = new Map(message.parts.filter((p): p is ToolResultPart => p.type === 'tool_result').map((p) => [p.callId, p]));
  const sources = message.parts.flatMap((p) => (p.type === 'tool_result' ? (p.sources ?? []) : []));
  const working = message.status === 'streaming' || message.status === 'awaiting_approval';
  const hasText = message.parts.some((p) => p.type === 'text' && p.text.trim());
  const error = message.error;

  return (
    <article className="msg msg-assistant" aria-label={`${message.profileName ?? 'Assistant'} response`}>
      <div className="msg-label">
        <span className="who">{message.profileName ?? 'Assistant'}</span>
        {message.modelLabel && <span title={message.connectionLabel ? `${message.modelLabel} via ${message.connectionLabel}` : undefined}>· {message.modelLabel}</span>}
      </div>
      {message.parts.map((part, i) => {
        if (part.type === 'text') return part.text ? <Markdown key={i} text={part.text} /> : null;
        if (part.type === 'notice') {
          return (
            <div key={i} className={cx('notice', part.level === 'warning' && 'warning')}>
              <Info size={14} aria-hidden="true" />
              <span>{part.text}</span>
            </div>
          );
        }
        if (part.type === 'tool_call') {
          const approval = part.approvalId ? approvals.find((a) => a.id === part.approvalId && a.status === 'pending') : undefined;
          return (
            <Fragment key={i}>
              <ToolCard call={part} result={results.get(part.id)} />
              {part.status === 'awaiting_approval' && approval && <ApprovalCard approval={approval} onDecide={onDecide} />}
            </Fragment>
          );
        }
        return null;
      })}
      {working && !hasText && message.parts.every((p) => p.type !== 'tool_call' || p.status !== 'running') && (
        <div className="typing" aria-label="Writing a response">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.status === 'error' && error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <div className="notice-body">
            <span>{error.message}</span>
            <div className="notice-actions">
              {canRetry && isLast && (
                <Button size="sm" onClick={() => onRetry(message.id)}>
                  <RotateCcw size={13} /> Retry
                </Button>
              )}
              {(error.action === 'reconnect' || error.action === 'settings') && (
                <Button size="sm" variant="ghost" onClick={() => navigate(paths.settings('models'))}>
                  Open model settings
                </Button>
              )}
              {error.action === 'choose_model' && <span className="muted">You can pick another model below and retry.</span>}
            </div>
          </div>
        </div>
      )}
      {(message.status === 'cancelled' || message.status === 'interrupted') && (
        <div className="stopped">
          <span>{message.status === 'cancelled' ? 'Stopped.' : 'Interrupted when Theologians closed.'}</span>
          {canRetry && isLast && (
            <Button size="sm" variant="ghost" onClick={() => onRetry(message.id)}>
              <RotateCcw size={13} /> Retry
            </Button>
          )}
        </div>
      )}
      <Sources sources={sources} />
      {!working && (
        <div className={cx('msg-actions', isLast && 'always')}>
          {hasText && <CopyButton text={message.content} label="Copy response" />}
          {canRetry && isLast && message.status === 'complete' && (
            <IconButton size="sm" label="Regenerate response" onClick={() => onRetry(message.id)}>
              <RotateCcw size={14} />
            </IconButton>
          )}
          {message.context && <ContextInfo report={message.context} />}
          <span className="msg-time">{formatDateTime(message.createdAt)}</span>
        </div>
      )}
    </article>
  );
}

export function MessageList({
  conversationId,
  messages,
  approvals,
  generating,
  onRetry,
  onDecide,
  emptyState,
}: {
  conversationId: string | null;
  messages: MessageDto[];
  approvals: ToolApprovalDto[];
  generating: boolean;
  onRetry: (id: string) => void;
  onDecide: (id: string, decision: 'approved' | 'denied') => void;
  emptyState?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const visible = useMemo(() => messages.filter((m) => !m.superseded || expanded.has(m.id)), [messages, expanded]);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant' && !m.superseded)?.id;

  useEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = nearBottom;
    setShowJump(!nearBottom && messages.length > 0);
  };

  return (
    <div className="messages" ref={scrollRef} onScroll={onScroll} aria-live="polite" aria-busy={generating}>
      <div className="messages-inner">
        {messages.length === 0 && emptyState}
        {visible.map((message, index) => {
          const supersededBefore = messages.filter((m) => m.superseded && m.seq < message.seq && (index === 0 || m.seq > visible[index - 1]!.seq));
          return (
            <Fragment key={message.id}>
              {supersededBefore.length > 0 && !supersededBefore.every((m) => expanded.has(m.id)) && (
                <button type="button" className="earlier-attempts" onClick={() => setExpanded(new Set([...expanded, ...supersededBefore.map((m) => m.id)]))}>
                  Show {plural(supersededBefore.length, 'earlier attempt')}
                </button>
              )}
              {message.role === 'user' ? (
                <article className="msg msg-user" aria-label="Your message">
                  <Attachments message={message} />
                  {message.content && <div className="bubble">{message.content}</div>}
                  <div className="msg-actions">
                    <CopyButton text={message.content} label="Copy message" />
                  </div>
                </article>
              ) : (
                <div className={cx(message.superseded && 'superseded')}>
                  <AssistantMessage
                    message={message}
                    approvals={approvals}
                    isLast={message.id === lastAssistantId}
                    canRetry={!generating && !message.superseded}
                    onRetry={onRetry}
                    onDecide={onDecide}
                  />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            stick.current = true;
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
    </div>
  );
}
