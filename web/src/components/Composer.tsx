import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUp, ChevronDown, FolderCode, Globe, Loader2, Paperclip, Plus, Square, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { ACCESS_TYPE_LABELS, MAX_ATTACHMENT_BYTES } from '../../../shared/constants.ts';
import type { AttachmentDto, CatalogModelDto, ConversationDetailDto, DraftDto, ProfileDto } from '../../../shared/types.ts';
import { api, clientId } from '../api/client.ts';
import { onLiveEvent } from '../api/events.ts';
import { formatBytes } from '../lib/format.ts';
import { takePrefill } from '../lib/prefill.ts';
import { navigate, paths } from '../lib/router.ts';
import { shortcut } from '../lib/shortcuts.ts';
import { MenuList, Popover, usePopover, type MenuNode } from './Menu.tsx';
import { toast, toastError } from './toast.tsx';
import { Badge, cx, IconButton, Switch } from './ui.tsx';

interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  attachment?: AttachmentDto;
  error?: string;
}

export type DraftTarget = { type: 'conversation'; id: string; text: string; attachmentIds: string[] } | { type: 'new'; key: string };

/** Last draft saved in this view, so quickly switching away and back never races the server save. */
const recentDrafts = new Map<string, { text: string; ids: string[] }>();

export interface ComposerHandle {
  focus: () => void;
}

export interface Selection {
  profileId: string | null;
  modelId: string | null;
}

// ── Model / assistant picker ─────────────────────────────────────────────────
export function ModelPicker({
  mode,
  profiles,
  models,
  selection,
  profile,
  defaultGeneralId,
  onChange,
}: {
  mode: 'chat' | 'model_only';
  profiles: ProfileDto[];
  models: CatalogModelDto[];
  selection: Selection;
  profile: ProfileDto | undefined;
  defaultGeneralId: string | undefined;
  onChange: (next: { profileId?: string; modelId?: string | null }) => void;
}) {
  const { open, close, toggle, anchorRef } = usePopover();
  const enabled = models.filter((m) => m.enabled);
  const resolvedModelId = selection.modelId ?? profile?.preferredModelId ?? null;
  const resolvedModel = models.find((m) => m.id === resolvedModelId);
  const isGeneralDefault = !profile || profile.id === defaultGeneralId;

  const badge = (m: CatalogModelDto): ReactNode => {
    const status =
      m.connectionStatus === 'verified' ? null : m.connectionStatus === 'expired' ? 'Expired' : m.connectionStatus === 'needs_credentials' ? 'Needs key' : m.connectionStatus === 'error' ? 'Error' : 'Unverified';
    return (
      <span className="picker-badges">
        {m.accessType !== 'paid_api' && <Badge>{ACCESS_TYPE_LABELS[m.accessType]}</Badge>}
        {status && <Badge tone={m.connectionStatus === 'unverified' ? 'neutral' : 'warning'}>{status}</Badge>}
      </span>
    );
  };

  const nodes: MenuNode[] = [];
  if (mode === 'chat') {
    nodes.push({ type: 'label', id: 'models-label', label: 'Models' });
    if (enabled.length === 0) nodes.push({ id: 'no-models', label: 'No models yet', description: 'Add one in Settings → Models', disabled: true, onSelect: () => undefined });
    for (const m of enabled) {
      nodes.push({
        id: `model-${m.id}`,
        label: m.displayName,
        description: m.connectionName,
        trailing: badge(m),
        checked: isGeneralDefault && resolvedModelId === m.id,
        onSelect: () => onChange({ profileId: defaultGeneralId, modelId: m.id }),
      });
    }
    const assistants = profiles.filter((p) => p.id !== defaultGeneralId);
    if (assistants.length) {
      nodes.push({ type: 'separator', id: 'sep-assistants' }, { type: 'label', id: 'assistants-label', label: 'Assistants' });
      for (const p of assistants) {
        const pm = models.find((m) => m.id === p.preferredModelId);
        nodes.push({
          id: `profile-${p.id}`,
          label: p.name,
          description: pm ? `${p.description} · ${pm.displayName}` : `${p.description} · no model set`,
          checked: profile?.id === p.id && !isGeneralDefault,
          onSelect: () => onChange({ profileId: p.id, modelId: null }),
        });
      }
    }
  } else {
    const preferred = models.find((m) => m.id === profile?.preferredModelId);
    nodes.push({ type: 'label', id: 'for', label: `Model for ${profile?.name ?? 'this assistant'}` });
    nodes.push({
      id: 'default',
      label: 'Assistant default',
      description: preferred ? preferred.displayName : 'Not set — choose one in Settings → Assistants',
      checked: selection.modelId === null,
      onSelect: () => onChange({ modelId: null }),
    });
    for (const m of enabled) {
      nodes.push({ id: `model-${m.id}`, label: m.displayName, description: m.connectionName, trailing: badge(m), checked: selection.modelId === m.id, onSelect: () => onChange({ modelId: m.id }) });
    }
  }
  nodes.push({ type: 'separator', id: 'sep-manage' }, { id: 'manage', label: 'Manage models and assistants…', onSelect: () => navigate(paths.settings('models')) });

  const label = mode === 'chat' && !isGeneralDefault ? profile?.name : (resolvedModel?.displayName ?? (mode === 'chat' ? 'Choose a model' : 'Choose a model'));
  const sub = mode === 'chat' && !isGeneralDefault ? (resolvedModel?.displayName ?? 'no model') : null;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cx('picker-btn', !resolvedModel && 'needs-choice')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model and assistant: ${label}${sub ? `, ${sub}` : ''}. Change`}
        onClick={toggle}
      >
        <span className="picker-label truncate">{label}</span>
        {sub && <span className="picker-sub truncate">{sub}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Popover open={open} onClose={close} anchorRef={anchorRef} placement="top-end" className="picker-menu" role="presentation">
        <MenuList nodes={nodes} onClose={close} label="Choose model or assistant" />
      </Popover>
    </>
  );
}

// ── Tools menu ───────────────────────────────────────────────────────────────
export interface ToolToggles {
  webSearchEnabled: boolean;
  filesEnabled: boolean;
}

export function ToolsMenu({
  toggles,
  onToggle,
  webSearchReady,
  showFiles,
  workingFolder,
  sandboxAvailable,
  onChooseFolder,
  onAttach,
}: {
  toggles: ToolToggles;
  onToggle: (patch: Partial<ToolToggles>) => void;
  webSearchReady: boolean;
  showFiles: boolean;
  workingFolder: string | null;
  sandboxAvailable: boolean;
  onChooseFolder: () => void;
  onAttach: () => void;
}) {
  const { open, close, toggle, anchorRef } = usePopover();
  return (
    <>
      <IconButton ref={anchorRef} label="Attach files and tools" onClick={toggle} aria-expanded={open} aria-haspopup="dialog">
        <Plus size={18} />
      </IconButton>
      <Popover open={open} onClose={close} anchorRef={anchorRef} placement="top-start" className="tools-menu" label="Attachments and tools">
        <button
          type="button"
          className="menu-item"
          data-autofocus
          onClick={() => {
            close();
            onAttach();
          }}
        >
          <span className="menu-icon">
            <Paperclip size={15} />
          </span>
          <span className="menu-text">
            <span className="menu-title">Attach files</span>
            <span className="desc">Images, PDFs, text and code</span>
          </span>
        </button>
        <div className="menu-sep" />
        <div className="tool-toggle">
          <Globe size={15} aria-hidden="true" />
          <div className="menu-text">
            <span className="menu-title">Web search</span>
            <span className="desc">
              {webSearchReady ? (
                'Search the web with clickable sources'
              ) : (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    close();
                    navigate(paths.settings('tools'));
                  }}
                >
                  Set up a search API key
                </button>
              )}
            </span>
          </div>
          <Switch label="Web search" checked={toggles.webSearchEnabled} onChange={(v) => onToggle({ webSearchEnabled: v })} />
        </div>
        {showFiles && (
          <div className="tool-toggle">
            <FolderCode size={15} aria-hidden="true" />
            <div className="menu-text">
              <span className="menu-title">Files and commands</span>
              <span className="desc truncate" title={workingFolder ?? undefined}>
                {workingFolder ? workingFolder.split('/').slice(-2).join('/') : 'No working folder'}
                {' · '}
                <button type="button" className="link-button" onClick={onChooseFolder}>
                  {workingFolder ? 'Change' : 'Choose folder'}
                </button>
                {!sandboxAvailable && ' · commands unavailable'}
              </span>
            </div>
            <Switch label="Files and commands" checked={toggles.filesEnabled} disabled={!workingFolder} onChange={(v) => onToggle({ filesEnabled: v })} />
          </div>
        )}
      </Popover>
    </>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────
export const Composer = forwardRef<
  ComposerHandle,
  {
    draft: DraftTarget;
    workspaceId: string | null;
    conversationId: string | null;
    placeholder: string;
    generating: boolean;
    onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
    onStop: () => void;
    left?: ReactNode;
    right?: ReactNode;
    pills?: ReactNode;
    prefillTarget?: string;
    autoFocus?: boolean;
  }
>(function Composer({ draft, workspaceId, conversationId, placeholder, generating, onSend, onStop, left, right, pills, prefillTarget, autoFocus }, ref) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(draft.type === 'conversation' ? draft.text : (recentDrafts.get(draft.key)?.text ?? ''));
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastSaved = useRef(JSON.stringify({ text: draft.type === 'conversation' ? draft.text : '', ids: draft.type === 'conversation' ? draft.attachmentIds : [] }));
  const latest = useRef({ text, ids: [] as string[] });
  const draftKey = draft.type === 'conversation' ? `conversation:${draft.id}` : draft.key;

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  const readyIds = items.filter((i) => i.status === 'ready' && i.attachment).map((i) => i.attachment!.id);
  latest.current = { text, ids: readyIds };

  const loadAttachments = useCallback(async (ids: string[]) => {
    const loaded = await Promise.all(ids.map((id) => api.get<AttachmentDto>(`/api/attachments/${id}`).catch(() => null)));
    setItems(
      loaded
        .filter((a): a is AttachmentDto => a !== null)
        .map((a) => ({ localId: a.id, name: a.filename, size: a.sizeBytes, status: 'ready' as const, attachment: a })),
    );
  }, []);

  // Load a saved draft (new chats keep theirs on the server so every view sees it).
  useEffect(() => {
    let cancelled = false;
    if (draft.type === 'conversation') {
      if (draft.attachmentIds.length) void loadAttachments(draft.attachmentIds);
    } else {
      void api
        .get<DraftDto>(`/api/drafts/${draft.key}`)
        .then((saved) => {
          if (cancelled || latest.current.text) return;
          setText(saved.text);
          lastSaved.current = JSON.stringify({ text: saved.text, ids: saved.attachmentIds });
          if (saved.attachmentIds.length) void loadAttachments(saved.attachmentIds);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const save = useCallback(
    (keepalive = false) => {
      if (sendingRef.current) return;
      const payload = latest.current;
      const serialized = JSON.stringify(payload);
      if (serialized === lastSaved.current) return;
      lastSaved.current = serialized;
      recentDrafts.set(draftKey, { text: payload.text, ids: payload.ids });
      if (draft.type === 'conversation') {
        // Keep the cached chat in step so coming back to it shows the draft immediately.
        queryClient.setQueryData<ConversationDetailDto>(['conversation', draft.id], (d) =>
          d ? { ...d, conversation: { ...d.conversation, draft: payload.text, draftAttachmentIds: payload.ids } } : d,
        );
      }
      const request =
        draft.type === 'conversation'
          ? api.put(`/api/conversations/${draft.id}/draft`, { draft: payload.text, attachmentIds: payload.ids }, keepalive)
          : api.put(`/api/drafts/${draft.key}`, { text: payload.text, attachmentIds: payload.ids }, keepalive);
      void request.catch(() => {
        lastSaved.current = '';
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftKey],
  );

  useEffect(() => {
    const timer = setTimeout(() => save(), 500);
    return () => clearTimeout(timer);
  }, [text, readyIds.join(','), save]);

  useEffect(() => {
    const flush = (): void => save(true);
    const onVisibility = (): void => {
      if (document.hidden) flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [save]);

  // Drafts typed in another window show up here unless you're actively editing this one.
  useEffect(
    () =>
      onLiveEvent((event) => {
        if (event.type !== 'draft.updated' || event.originClientId === clientId) return;
        const matches = draft.type === 'conversation' ? event.conversationId === draft.id : event.key === draft.key;
        if (!matches) return;
        const editing = document.activeElement === textareaRef.current && JSON.stringify(latest.current) !== lastSaved.current;
        if (editing) return;
        setText(event.draft);
        lastSaved.current = JSON.stringify({ text: event.draft, ids: event.attachmentIds });
        void loadAttachments(event.attachmentIds);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftKey],
  );

  useEffect(() => {
    if (!prefillTarget) return;
    const waiting = takePrefill(prefillTarget);
    if (waiting) {
      setText(waiting);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    const onPrefill = (event: Event): void => {
      const detail = (event as CustomEvent<{ target: string; text: string }>).detail;
      if (detail.target !== prefillTarget) return;
      takePrefill(prefillTarget);
      setText(detail.text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('theologians:prefill', onPrefill);
    return () => window.removeEventListener('theologians:prefill', onPrefill);
  }, [prefillTarget]);

  useEffect(() => {
    const onFocus = (): void => textareaRef.current?.focus();
    window.addEventListener('theologians:focus-composer', onFocus);
    if (autoFocus) requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.removeEventListener('theologians:focus-composer', onFocus);
  }, [autoFocus]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const addFiles = async (files: File[]): Promise<void> => {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast(`${file.name} is larger than 50 MB.`, 'error');
        continue;
      }
      const localId = crypto.randomUUID();
      setItems((current) => [...current, { localId, name: file.name || 'pasted-image.png', size: file.size, status: 'uploading' }]);
      const params = new URLSearchParams({ filename: file.name || 'pasted-image.png' });
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (conversationId) params.set('conversationId', conversationId);
      try {
        const attachment = await api.upload<AttachmentDto>(`/api/attachments?${params}`, file, file.type);
        setItems((current) => current.map((i) => (i.localId === localId ? { ...i, status: 'ready', attachment } : i)));
        if (attachment.extractionStatus === 'no_text' || attachment.extractionStatus === 'partial' || attachment.kind === 'unsupported') {
          toast(`${attachment.filename}: ${attachment.extractionDetail ?? 'only partly readable'}`, 'error');
        }
      } catch (err) {
        setItems((current) => current.map((i) => (i.localId === localId ? { ...i, status: 'error', error: err instanceof Error ? err.message : String(err) } : i)));
      }
    }
  };

  const remove = (item: PendingAttachment): void => {
    setItems((current) => current.filter((i) => i.localId !== item.localId));
    if (item.attachment) void api.delete(`/api/attachments/${item.attachment.id}`).catch(() => undefined);
  };

  const uploading = items.some((i) => i.status === 'uploading');
  const canSend = !generating && !sending && !uploading && (text.trim().length > 0 || readyIds.length > 0);

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const sentText = text;
    const sentIds = readyIds;
    const empty = { text: '', ids: [] as string[] };
    setSending(true);
    sendingRef.current = true;
    try {
      const ok = await onSend(sentText, sentIds);
      if (ok) {
        // The message is saved. Make sure no pending draft save (e.g. on unmount) brings the sent text back.
        latest.current = empty;
        lastSaved.current = JSON.stringify(empty);
        recentDrafts.set(draftKey, empty);
        if (draft.type === 'conversation') {
          queryClient.setQueryData<ConversationDetailDto>(['conversation', draft.id], (d) =>
            d ? { ...d, conversation: { ...d.conversation, draft: '', draftAttachmentIds: [] } } : d,
          );
        }
        setText('');
        setItems([]);
      }
    } catch (err) {
      toastError(err);
    } finally {
      sendingRef.current = false;
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  return (
    <div
      className={cx('composer', dragging && 'dragging')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }
      }}
    >
      {items.length > 0 && (
        <div className="attachment-chips">
          {items.map((item) => (
            <span key={item.localId} className={cx('chip', item.status === 'error' && 'chip-error')} title={item.error ?? item.attachment?.extractionDetail ?? item.name}>
              {item.status === 'uploading' ? <Loader2 size={13} className="spin" aria-label="Uploading" /> : item.status === 'error' ? <AlertTriangle size={13} aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />}
              <span className="truncate">{item.name}</span>
              <span className="muted">{item.status === 'error' ? 'failed' : formatBytes(item.size)}</span>
              <IconButton size="sm" label={`Remove ${item.name}`} onClick={() => remove(item)}>
                <X size={12} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
          if (e.key === '.' && (e.metaKey || e.ctrlKey) && generating) {
            e.preventDefault();
            onStop();
          }
        }}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <div className="composer-bar">
        <div className="left">
          {left ?? (
            <IconButton label="Attach files" onClick={() => fileRef.current?.click()}>
              <Paperclip size={17} />
            </IconButton>
          )}
          {pills}
        </div>
        <div className="right">
          {right}
          {generating ? (
            <button type="button" className="send-btn stop" aria-label={`Stop generating (${shortcut('.')})`} title={`Stop (${shortcut('.')})`} onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" aria-label="Send message" title="Send (Enter)" disabled={!canSend} onClick={() => void submit()}>
              {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
            </button>
          )}
        </div>
      </div>
      <span hidden data-file-trigger onClick={() => fileRef.current?.click()} />
    </div>
  );
});

export function openFilePicker(container: HTMLElement | null): void {
  container?.querySelector<HTMLElement>('[data-file-trigger]')?.click();
}
