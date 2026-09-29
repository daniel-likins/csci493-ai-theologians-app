import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { confirmDialog, promptDialog } from '../components/Dialog.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { navigate, paths } from '../lib/router.ts';

type ScanResult =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'done'; suggested: number; autoSaved: number; duplicates: number };

export function useChatActions(workspace: WorkspaceDto) {
  const queryClient = useQueryClient();
  const refresh = (id: string): void => {
    void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['conversation', id] });
  };

  return {
    rename: async (chat: { id: string; title: string }): Promise<void> => {
      const title = await promptDialog({ title: 'Rename chat', label: 'Chat title', initial: chat.title, confirmLabel: 'Rename' });
      if (!title || title === chat.title) return;
      try {
        await api.patch(`/api/conversations/${chat.id}`, { title });
        refresh(chat.id);
      } catch (err) {
        toastError(err);
      }
    },
    move: async (chat: { id: string }, folderId: string | null, folderName?: string): Promise<void> => {
      try {
        await api.patch(`/api/conversations/${chat.id}`, { folderId });
        refresh(chat.id);
        toast(folderId ? `Moved to ${folderName}` : 'Removed from folder');
      } catch (err) {
        toastError(err);
      }
    },
    remove: async (chat: { id: string; title: string }, isOpen: boolean): Promise<void> => {
      const ok = await confirmDialog({
        title: 'Delete this chat?',
        message: `“${chat.title}” and its messages will be deleted from Theologians. Earlier automatic backups may still contain it.`,
        confirmLabel: 'Delete chat',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`/api/conversations/${chat.id}`);
        if (isOpen) navigate(paths.mission(workspace.slug), { replace: true });
        void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
        queryClient.removeQueries({ queryKey: ['conversation', chat.id] });
        toast('Chat deleted');
      } catch (err) {
        toastError(err);
      }
    },
    suggestMemory: async (chatId: string): Promise<void> => {
      toast(`Asking ${workspace.name} to review this chat…`);
      try {
        const result = await api.post<ScanResult>(`/api/conversations/${chatId}/suggest-memory`);
        if (result.status === 'done') {
          const total = result.suggested + result.autoSaved;
          toast(
            total === 0
              ? 'No important memory updates found in this chat.'
              : `${result.suggested ? `${result.suggested} suggestion${result.suggested === 1 ? '' : 's'} to review` : ''}${result.suggested && result.autoSaved ? ', ' : ''}${result.autoSaved ? `${result.autoSaved} saved automatically` : ''}.`,
          );
          if (total > 0) window.dispatchEvent(new CustomEvent('theologians:open-goals', { detail: { tab: 'updates' } }));
        } else {
          toast(result.reason, result.status === 'failed' ? 'error' : 'info');
        }
      } catch (err) {
        toastError(err);
      }
    },
  };
}
