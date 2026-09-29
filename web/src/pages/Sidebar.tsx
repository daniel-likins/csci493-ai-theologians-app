import { useQueryClient } from '@tanstack/react-query';
import { Bookmark, ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Search, SquarePen, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { ConversationListItem, FolderDto, WorkspaceDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { confirmDialog, promptDialog } from '../components/Dialog.tsx';
import { MenuButton, type MenuNode } from '../components/Menu.tsx';
import { toastError } from '../components/toast.tsx';
import { cx, IconButton, Spinner } from '../components/ui.tsx';
import { useConversationList, useFolders } from '../lib/queries.ts';
import { navigate, paths } from '../lib/router.ts';
import { shortcut } from '../lib/shortcuts.ts';
import { useChatActions } from './chatActions.ts';

const COLLAPSED_KEY = 'theologians.collapsedFolders';

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function ChatRow({ chat, workspace, active, folders, indent }: { chat: ConversationListItem; workspace: WorkspaceDto; active: boolean; folders: FolderDto[]; indent?: boolean }) {
  const actions = useChatActions(workspace);
  const nodes: MenuNode[] = [
    { id: 'rename', label: 'Rename', icon: <Pencil size={15} />, onSelect: () => void actions.rename(chat) },
    { type: 'separator', id: 'sep' },
    { type: 'label', id: 'move', label: 'Move to folder' },
    { id: 'none', label: 'No folder', checked: chat.folderId === null, onSelect: () => void actions.move(chat, null) },
    ...folders.map((f) => ({ id: f.id, label: f.name, checked: chat.folderId === f.id, onSelect: () => void actions.move(chat, f.id, f.name) })),
    { type: 'separator', id: 'sep2' },
    ...(workspace.hasGoals ? [{ id: 'suggest', label: 'Suggest memory updates', icon: <Bookmark size={15} />, onSelect: () => void actions.suggestMemory(chat.id) }] : []),
    { id: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => void actions.remove(chat, active) },
  ];
  return (
    <div className={cx('chat-row', active && 'active', indent && 'indent')}>
      <button type="button" className="chat-link" aria-current={active ? 'page' : undefined} onClick={() => navigate(paths.conversation(workspace.slug, chat.id))}>
        <span className="truncate">{chat.title}</span>
        {chat.hasDraft && !active && <span className="draft-dot" title="Unsent draft" aria-label="Has an unsent draft" />}
      </button>
      <MenuButton label={`Options for ${chat.title}`} nodes={nodes} className="icon-btn sm row-menu">
        <MoreHorizontal size={15} />
      </MenuButton>
    </div>
  );
}

function FolderGroup({
  folder,
  chats,
  collapsed,
  onToggle,
  activeId,
  workspace,
  folders,
}: {
  folder: FolderDto;
  chats: ConversationListItem[];
  collapsed: boolean;
  onToggle: () => void;
  activeId: string | null;
  workspace: WorkspaceDto;
  folders: FolderDto[];
}) {
  const queryClient = useQueryClient();
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['folders', workspace.id] });
    void queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] });
  };
  const nodes: MenuNode[] = [
    {
      id: 'rename',
      label: 'Rename folder',
      icon: <Pencil size={15} />,
      onSelect: () =>
        void (async () => {
          const name = await promptDialog({ title: 'Rename folder', label: 'Folder name', initial: folder.name, confirmLabel: 'Rename' });
          if (!name) return;
          try {
            await api.patch(`/api/folders/${folder.id}`, { name });
            refresh();
          } catch (err) {
            toastError(err);
          }
        })(),
    },
    {
      id: 'delete',
      label: 'Delete folder',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () =>
        void (async () => {
          const ok = await confirmDialog({
            title: `Delete “${folder.name}”?`,
            message: chats.length ? `The folder is removed. Its ${chats.length} chat${chats.length === 1 ? '' : 's'} will stay, under Chats.` : 'The empty folder will be removed.',
            confirmLabel: 'Delete folder',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.delete(`/api/folders/${folder.id}`);
            refresh();
          } catch (err) {
            toastError(err);
          }
        })(),
    },
  ];
  return (
    <div className="folder">
      <div className="folder-row">
        <button type="button" className="folder-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          <ChevronRight size={13} className={cx('chev', !collapsed && 'open')} aria-hidden="true" />
          {collapsed ? <Folder size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
          <span className="truncate">{folder.name}</span>
          {chats.length > 0 && <span className="count">{chats.length}</span>}
        </button>
        <MenuButton label={`Options for folder ${folder.name}`} nodes={nodes} className="icon-btn sm row-menu">
          <MoreHorizontal size={15} />
        </MenuButton>
      </div>
      {!collapsed && (
        <div className="folder-children">
          {chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} workspace={workspace} active={chat.id === activeId} folders={folders} indent />
          ))}
          {chats.length === 0 && <p className="sidebar-hint indent">Empty</p>}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ workspace, activeId, width, overlay, onClose }: { workspace: WorkspaceDto; activeId: string | null; width: number; overlay: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const folders = useFolders(workspace.id);
  const chats = useConversationList(workspace.id);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);

  const toggleFolder = (id: string): void => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      // per-view convenience only
    }
  };

  const newFolder = async (): Promise<void> => {
    const name = await promptDialog({ title: `New folder in ${workspace.name}`, label: 'Folder name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      await api.post(`/api/workspaces/${workspace.id}/folders`, { name });
      void queryClient.invalidateQueries({ queryKey: ['folders', workspace.id] });
    } catch (err) {
      toastError(err);
    }
  };

  const all = chats.data ?? [];
  const folderList = folders.data ?? [];
  const byFolder = new Map<string, ConversationListItem[]>();
  for (const chat of all) {
    if (chat.folderId) byFolder.set(chat.folderId, [...(byFolder.get(chat.folderId) ?? []), chat]);
  }
  const unfiled = all.filter((c) => !c.folderId || !folderList.some((f) => f.id === c.folderId));

  return (
    <nav className={cx('sidebar', overlay && 'overlay')} style={{ width }} aria-label={`${workspace.name} chats`}>
      <div className="sidebar-actions">
        {overlay && (
          <IconButton label="Close sidebar" className="sidebar-close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        )}
        <button
          type="button"
          className="nav-row"
          aria-current={!activeId ? 'page' : undefined}
          onClick={() => {
            navigate(paths.mission(workspace.slug));
            window.dispatchEvent(new Event('theologians:focus-composer'));
            if (overlay) onClose();
          }}
        >
          <SquarePen size={16} aria-hidden="true" />
          <span>New chat</span>
          <kbd className="nav-kbd">{shortcut('O', true)}</kbd>
        </button>
        <button type="button" className="nav-row" onClick={() => window.dispatchEvent(new Event('theologians:search'))}>
          <Search size={16} aria-hidden="true" />
          <span>Search</span>
          <kbd className="nav-kbd">{shortcut('K')}</kbd>
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-label">
          <span>Folders</span>
          <IconButton size="sm" label="New folder" onClick={() => void newFolder()}>
            <FolderPlus size={14} />
          </IconButton>
        </div>
        {folders.isSuccess && folderList.length === 0 && <p className="sidebar-hint">No folders yet.</p>}
        {folderList.map((folder) => (
          <FolderGroup
            key={folder.id}
            folder={folder}
            chats={byFolder.get(folder.id) ?? []}
            collapsed={Boolean(collapsed[folder.id])}
            onToggle={() => toggleFolder(folder.id)}
            activeId={activeId}
            workspace={workspace}
            folders={folderList}
          />
        ))}
        <div className="sidebar-section-label">
          <span>Chats</span>
        </div>
        {chats.isPending ? (
          <div className="sidebar-hint">
            <Spinner />
          </div>
        ) : unfiled.length === 0 ? (
          <p className="sidebar-hint">{all.length === 0 ? 'No chats yet.' : 'All chats are in folders.'}</p>
        ) : (
          unfiled.map((chat) => <ChatRow key={chat.id} chat={chat} workspace={workspace} active={chat.id === activeId} folders={folderList} />)
        )}
      </div>
    </nav>
  );
}
