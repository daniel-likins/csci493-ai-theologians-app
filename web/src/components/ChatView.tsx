import { useQueryClient } from '@tanstack/react-query';
import { FolderCode, Globe, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { BootstrapDto, ConversationDetailDto, ConversationDto, ConversationKind, MessageDto, ProfileDto, WorkspaceDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { usePreference } from '../lib/prefs.ts';
import { useConversation, useModels, useProfiles, useToolSettings, useWorkspaceSettings } from '../lib/queries.ts';
import { Composer, ModelPicker, openFilePicker, ToolsMenu, type ComposerHandle, type Selection, type ToolToggles } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { toast, toastError } from './toast.tsx';
import { cx, Spinner } from './ui.tsx';

function usableProfile(p: ProfileDto, kind: ConversationKind, workspaceId: string | null): boolean {
  if (kind === 'master') return p.kind === 'master';
  if (kind === 'goals') return p.kind === 'goals' && p.workspaceId === workspaceId;
  return (p.kind === 'general' && (p.workspaceId === null || p.workspaceId === workspaceId)) || (p.kind === 'goals' && p.workspaceId === workspaceId);
}

export function ChatView({
  kind,
  workspace,
  conversationId,
  newDraftKey,
  onCreated,
  emptyState,
  compact,
  placeholder,
  prefillTarget,
  autoFocus,
}: {
  kind: ConversationKind;
  workspace: WorkspaceDto | null;
  conversationId: string | null | undefined;
  newDraftKey?: string;
  onCreated?: (id: string) => void;
  emptyState?: ReactNode;
  compact?: boolean;
  placeholder?: string;
  prefillTarget?: string;
  autoFocus?: boolean;
}) {
  const queryClient = useQueryClient();
  const detail = useConversation(conversationId);
  const models = useModels();
  const profiles = useProfiles();
  const toolSettings = useToolSettings();
  const workspaceSettings = useWorkspaceSettings(kind === 'chat' ? workspace?.id : undefined);
  const [lastSelection, setLastSelection] = usePreference<Selection | null>(`selection.last.${workspace?.id ?? 'home'}`, null);
  const [newToggles, setNewToggles] = useState<ToolToggles>({ webSearchEnabled: false, filesEnabled: false });
  const composerRef = useRef<ComposerHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const conversation = detail.data?.conversation;
  const messages = detail.data?.messages ?? [];
  const approvals = detail.data?.approvals ?? [];
  const workspaceId = workspace?.id ?? null;
  const allProfiles = profiles.data ?? [];
  const usable = detail.data?.options.profiles ?? allProfiles.filter((p) => usableProfile(p, kind, workspaceId));
  const defaultGeneral = allProfiles.find((p) => p.defaultKey === 'general.assistant');
  // In a theologian's chats, that theologian answers unless another assistant is picked.
  const fallbackProfile =
    kind === 'master' ? usable.find((p) => p.kind === 'master') : (usable.find((p) => p.kind === 'goals') ?? (kind === 'goals' ? undefined : defaultGeneral));

  const selection: Selection = conversation
    ? { profileId: conversation.selectedProfileId, modelId: conversation.selectedModelId }
    : kind === 'chat'
      ? (lastSelection ?? { profileId: null, modelId: null })
      : { profileId: fallbackProfile?.id ?? null, modelId: lastSelection?.modelId ?? null };
  const profile = usable.find((p) => p.id === selection.profileId) ?? fallbackProfile;
  const resolvedModelId = selection.modelId ?? profile?.preferredModelId ?? null;
  const generatingMessage = messages.find((m) => m.status === 'streaming' || m.status === 'awaiting_approval');
  const generating = Boolean(generatingMessage);
  const toggles: ToolToggles = conversation ? { webSearchEnabled: conversation.webSearchEnabled, filesEnabled: conversation.filesEnabled } : newToggles;
  const workingFolder = workspaceSettings.data?.workingFolder ?? null;

  const updateConversationCache = (updated: ConversationDto): void => {
    queryClient.setQueryData<ConversationDetailDto>(['conversation', updated.id], (d) => (d ? { ...d, conversation: updated } : d));
  };

  // Selection and toggle changes may still be saving when Enter is pressed; sending waits for them and
  // reads the freshest values rather than whatever this render captured.
  const pendingUpdates = useRef<Promise<unknown>>(Promise.resolve());
  const track = (work: Promise<unknown>): void => {
    pendingUpdates.current = Promise.allSettled([pendingUpdates.current, work]);
  };
  const newTogglesRef = useRef(newToggles);
  newTogglesRef.current = newToggles;

  const readSelection = (): Selection => {
    if (conversation) {
      const fresh = queryClient.getQueryData<ConversationDetailDto>(['conversation', conversation.id])?.conversation ?? conversation;
      return { profileId: fresh.selectedProfileId, modelId: fresh.selectedModelId };
    }
    const saved = queryClient.getQueryData<BootstrapDto>(['bootstrap'])?.preferences[`selection.last.${workspace?.id ?? 'home'}`] as Selection | null | undefined;
    return kind === 'chat' ? (saved ?? { profileId: null, modelId: null }) : { profileId: fallbackProfile?.id ?? null, modelId: saved?.modelId ?? null };
  };

  const changeSelection = async (next: { profileId?: string; modelId?: string | null }): Promise<void> => {
    const current = readSelection();
    const merged: Selection = { profileId: next.profileId ?? current.profileId, modelId: next.modelId !== undefined ? next.modelId : current.modelId };
    setLastSelection(merged);
    if (!conversation) return;
    const work = api
      .patch<ConversationDto>(`/api/conversations/${conversation.id}`, { selectedProfileId: merged.profileId ?? undefined, selectedModelId: merged.modelId })
      .then((updated) => {
        updateConversationCache(updated);
        void queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] });
      })
      .catch(toastError);
    track(work);
    await work;
  };

  const changeToggles = async (patch: Partial<ToolToggles>): Promise<void> => {
    if (!conversation) {
      const next = { ...newTogglesRef.current, ...patch };
      newTogglesRef.current = next;
      setNewToggles(next);
      return;
    }
    const work = api
      .patch<ConversationDto>(`/api/conversations/${conversation.id}`, patch)
      .then(updateConversationCache)
      .catch(toastError);
    track(work);
    await work;
  };

  const chooseFolder = async (): Promise<void> => {
    if (!workspace) return;
    try {
      const result = await api.post<{ path: string | null }>('/api/system/choose-folder', { prompt: `Choose a working folder for ${workspace.name}` });
      if (!result.path) return;
      await api.patch(`/api/workspaces/${workspace.id}/settings`, { workingFolder: result.path });
      void queryClient.invalidateQueries({ queryKey: ['workspaceSettings', workspace.id] });
      await changeToggles({ filesEnabled: true });
      toast(`Working folder: ${result.path}`);
    } catch (err) {
      toastError(err);
    }
  };

  const send = async (text: string, attachmentIds: string[]): Promise<boolean> => {
    await pendingUpdates.current;
    const current = readSelection();
    const currentProfile = usable.find((p) => p.id === current.profileId) ?? fallbackProfile;
    if (!(current.modelId ?? currentProfile?.preferredModelId)) {
      toast(
        currentProfile?.kind === 'general' || !currentProfile
          ? 'Choose a model first (picker next to the send button).'
          : `Choose a model for ${currentProfile.name} in Settings → Assistants, or pick one in the picker.`,
        'error',
      );
      return false;
    }
    let id = conversation?.id;
    let createdHere = false;
    try {
      if (!id) {
        const toggles = newTogglesRef.current;
        const created = await api.post<ConversationDto>('/api/conversations', {
          workspaceId,
          kind,
          selectedProfileId: kind === 'chat' ? (current.profileId ?? undefined) : undefined,
          selectedModelId: current.modelId ?? undefined,
          ...(kind === 'chat' ? toggles : { webSearchEnabled: toggles.webSearchEnabled }),
        });
        id = created.id;
        createdHere = true;
      }
      const result = await api.post<{ userMessage: MessageDto; assistantMessage: MessageDto }>(`/api/conversations/${id}/messages`, { text, attachmentIds });
      if (createdHere) {
        if (newDraftKey) void api.put(`/api/drafts/${newDraftKey}`, { text: '', attachmentIds: [] }).catch(() => undefined);
        await queryClient.prefetchQuery({ queryKey: ['conversation', id], queryFn: () => api.get<ConversationDetailDto>(`/api/conversations/${id}`) });
        onCreated?.(id);
      } else {
        queryClient.setQueryData<ConversationDetailDto>(['conversation', id], (d) =>
          d ? { ...d, messages: [...d.messages.filter((m) => m.id !== result.userMessage.id && m.id !== result.assistantMessage.id), result.userMessage, result.assistantMessage] } : d,
        );
      }
      return true;
    } catch (err) {
      if (createdHere && id) void api.delete(`/api/conversations/${id}`).catch(() => undefined);
      toastError(err);
      return false;
    }
  };

  const stop = (): void => {
    if (generatingMessage) void api.post(`/api/messages/${generatingMessage.id}/cancel`).catch(toastError);
  };

  const retry = (messageId: string): void => {
    void api
      .post<MessageDto>(`/api/messages/${messageId}/retry`)
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }))
      .catch(toastError);
  };

  const decide = (approvalId: string, decision: 'approved' | 'denied'): void => {
    void api
      .post(`/api/approvals/${approvalId}`, { decision })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }))
      .catch((err) => {
        toastError(err);
        void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      });
  };

  if (conversationId && detail.isPending) {
    return (
      <div className={cx('chat', compact && 'compact')}>
        <div className="chat-loading">
          <Spinner label="Loading conversation" />
        </div>
      </div>
    );
  }
  if (conversationId && detail.isError) {
    return (
      <div className={cx('chat', compact && 'compact')}>
        <div className="empty-state">This conversation couldn't be loaded. It may have been deleted in another window.</div>
      </div>
    );
  }

  const webReady = detail.data?.options.webSearchReady ?? toolSettings.data?.webSearchHasKey ?? false;
  const sandbox = detail.data?.options.sandboxAvailable ?? toolSettings.data?.sandboxAvailable ?? false;
  const showFiles = kind === 'chat' && Boolean(profile?.allowedTools.includes('files'));
  const pickerMode = kind === 'chat' ? 'chat' : 'model_only';

  return (
    <div className={cx('chat', compact && 'compact')} ref={containerRef}>
      <MessageList conversationId={conversationId ?? null} messages={messages} approvals={approvals} generating={generating} onRetry={retry} onDecide={decide} emptyState={emptyState} />
      <div className="composer-wrap">
        <Composer
          ref={composerRef}
          key={conversation?.id ?? newDraftKey}
          draft={conversation ? { type: 'conversation', id: conversation.id, text: conversation.draft, attachmentIds: conversation.draftAttachmentIds } : { type: 'new', key: newDraftKey ?? 'new.home' }}
          workspaceId={workspaceId}
          conversationId={conversation?.id ?? null}
          placeholder={placeholder ?? 'Message'}
          generating={generating}
          onSend={send}
          onStop={stop}
          prefillTarget={prefillTarget}
          autoFocus={autoFocus}
          left={
            <ToolsMenu
              toggles={toggles}
              onToggle={(patch) => void changeToggles(patch)}
              webSearchReady={webReady}
              showFiles={showFiles}
              workingFolder={workingFolder}
              sandboxAvailable={sandbox}
              onChooseFolder={() => void chooseFolder()}
              onAttach={() => openFilePicker(containerRef.current)}
            />
          }
          pills={
            <>
              {toggles.webSearchEnabled && (
                <button type="button" className="tool-pill" onClick={() => void changeToggles({ webSearchEnabled: false })} title="Web search is on. Click to turn off.">
                  <Globe size={13} aria-hidden="true" /> Search <X size={11} aria-hidden="true" />
                  <span className="visually-hidden">Turn off web search</span>
                </button>
              )}
              {toggles.filesEnabled && showFiles && (
                <button type="button" className="tool-pill" onClick={() => void changeToggles({ filesEnabled: false })} title={`Files and commands in ${workingFolder ?? 'no folder'}. Click to turn off.`}>
                  <FolderCode size={13} aria-hidden="true" /> {workingFolder ? workingFolder.split('/').at(-1) : 'Files'} <X size={11} aria-hidden="true" />
                  <span className="visually-hidden">Turn off files and commands</span>
                </button>
              )}
            </>
          }
          right={
            <ModelPicker
              mode={pickerMode}
              profiles={usable}
              models={models.data ?? []}
              selection={selection}
              profile={profile}
              defaultGeneralId={kind === 'chat' ? fallbackProfile?.id : defaultGeneral?.id}
              onChange={(next) => void changeSelection(next)}
            />
          }
        />
      </div>
    </div>
  );
}
