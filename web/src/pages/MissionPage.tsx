import { Bookmark, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceDto } from '../../../shared/types.ts';
import { GOALS_PANEL_DEFAULT, SIDEBAR_DEFAULT, type PanelPrefs } from '../App.tsx';
import { ChatView } from '../components/ChatView.tsx';
import { MenuButton, type MenuNode } from '../components/Menu.tsx';
import { Button, cx, Spinner } from '../components/ui.tsx';
import { usePreference } from '../lib/prefs.ts';
import { useConversation, useFolders, useWorkspaces } from '../lib/queries.ts';
import { navigate, paths } from '../lib/router.ts';
import { useChatActions } from './chatActions.ts';
import { GoalsPanel } from './GoalsPanel.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import { Sidebar } from './Sidebar.tsx';

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

function Resizer({
  label,
  value,
  min,
  max,
  direction,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const widthAt = (clientX: number): number => clamp(start.current.width + (clientX - start.current.x) * direction, min, max);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className={cx('resizer', dragging && 'dragging')}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: value };
        setDragging(true);
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (dragging) onChange(widthAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        setDragging(false);
        document.body.classList.remove('resizing');
        onCommit(widthAt(e.clientX));
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = clamp(value + (e.key === 'ArrowRight' ? 16 : -16) * direction, min, max);
        onChange(next);
        onCommit(next);
      }}
    />
  );
}

function MissionChat({ workspace, conversationId }: { workspace: WorkspaceDto; conversationId: string | null }) {
  const detail = useConversation(conversationId);
  const folders = useFolders(workspace.id);
  const actions = useChatActions(workspace);
  const conversation = detail.data?.conversation;

  const nodes: MenuNode[] = conversation
    ? [
        { id: 'rename', label: 'Rename', icon: <Pencil size={15} />, onSelect: () => void actions.rename(conversation) },
        { type: 'separator', id: 'sep-move' },
        { type: 'label', id: 'move', label: 'Move to folder' },
        { id: 'no-folder', label: 'No folder', checked: conversation.folderId === null, onSelect: () => void actions.move(conversation, null) },
        ...(folders.data ?? []).map((f) => ({ id: f.id, label: f.name, checked: conversation.folderId === f.id, onSelect: () => void actions.move(conversation, f.id, f.name) })),
        { type: 'separator', id: 'sep-memory' },
        ...(workspace.hasGoals
          ? [{ id: 'suggest', label: 'Suggest memory updates', description: `${workspace.name} reviews this chat`, icon: <Bookmark size={15} />, onSelect: () => void actions.suggestMemory(conversation.id) }]
          : []),
        { id: 'delete', label: 'Delete chat', icon: <Trash2 size={15} />, danger: true, onSelect: () => void actions.remove(conversation, true) },
      ]
    : [];

  return (
    <>
      <div className="chat-header">
        {conversation ? (
          <>
            <button type="button" className="chat-title" onClick={() => void actions.rename(conversation)} title="Rename chat" aria-label={`Rename chat “${conversation.title}”`}>
              {conversation.title}
            </button>
            <MenuButton label="Chat options" nodes={nodes} className="icon-btn">
              <MoreHorizontal size={17} />
            </MenuButton>
          </>
        ) : (
          <span className="chat-title static">{conversationId ? '' : 'New chat'}</span>
        )}
      </div>
      <ChatView
        kind="chat"
        workspace={workspace}
        conversationId={conversationId}
        newDraftKey={`new.${workspace.id}`}
        onCreated={(id) => navigate(paths.conversation(workspace.slug, id), { replace: true })}
        placeholder={`Message ${workspace.name}`}
        autoFocus={!conversationId}
        emptyState={
          !conversationId ? (
            <div className="new-chat-empty">
              <h2>{workspace.name}</h2>
              <p>{workspace.description}</p>
            </div>
          ) : undefined
        }
      />
    </>
  );
}

export function MissionPage({ slug, conversationId }: { slug: string; conversationId: string | null }) {
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.workspaces.find((w) => w.slug === slug);
  const [sidebar, setSidebar] = usePreference<PanelPrefs>('ui.sidebar', SIDEBAR_DEFAULT);
  const [panel, setPanel] = usePreference('ui.goalsPanel', GOALS_PANEL_DEFAULT);
  const [sidebarWidth, setSidebarWidth] = useState(sidebar.width);
  const [panelWidth, setPanelWidth] = useState(panel.width);
  const windowWidth = useWindowWidth();

  useEffect(() => setSidebarWidth(sidebar.width), [sidebar.width]);
  useEffect(() => setPanelWidth(panel.width), [panel.width]);
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const tab = (event as CustomEvent<{ tab?: 'chat' | 'memory' | 'updates' }>).detail?.tab;
      setPanel({ ...panel, open: true, tab: tab ?? panel.tab });
    };
    window.addEventListener('theologians:open-goals', onOpen);
    return () => window.removeEventListener('theologians:open-goals', onOpen);
  }, [panel, setPanel]);

  if (workspaces.isPending) {
    return (
      <div className="page-center">
        <Spinner />
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="page-center">
        <div className="empty-state">
          <p>That theologian doesn't exist.</p>
          <Button onClick={() => navigate(paths.home())}>Go home</Button>
        </div>
      </div>
    );
  }

  const leftWidth = sidebar.open ? sidebarWidth : 0;
  const showPanel = panel.open && workspace.hasGoals;
  const sidebarOverlay = sidebar.open && windowWidth - sidebarWidth < 460;
  const panelOverlay = showPanel && windowWidth - (sidebarOverlay ? 0 : leftWidth) - panelWidth < 460;

  return (
    <div className="mission">
      {sidebar.open && (
        <>
          <Sidebar workspace={workspace} activeId={conversationId} width={sidebarWidth} overlay={sidebarOverlay} onClose={() => setSidebar({ ...sidebar, open: false })} />
          {!sidebarOverlay && (
            <Resizer label="Resize sidebar" value={sidebarWidth} min={200} max={420} direction={1} onChange={setSidebarWidth} onCommit={(width) => setSidebar({ ...sidebar, width })} />
          )}
        </>
      )}
      <section className="center" aria-label="Chat">
        <MissionChat key={conversationId ?? 'new'} workspace={workspace} conversationId={conversationId} />
      </section>
      {showPanel && (
        <>
          {!panelOverlay && (
            <Resizer label="Resize study notes" value={panelWidth} min={300} max={640} direction={-1} onChange={setPanelWidth} onCommit={(width) => setPanel({ ...panel, width })} />
          )}
          <GoalsPanel
            workspace={workspace}
            width={panelOverlay ? Math.min(panelWidth, windowWidth - 24) : panelWidth}
            overlay={panelOverlay}
            tab={panel.tab}
            onTab={(tab) => setPanel({ ...panel, tab })}
            onClose={() => setPanel({ ...panel, open: false })}
          />
        </>
      )}
      <SearchDialog workspace={workspace} />
    </div>
  );
}
