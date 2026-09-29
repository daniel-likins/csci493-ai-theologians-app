import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, History, SquarePen, Trash2 } from 'lucide-react';
import { api } from '../api/client.ts';
import { ChatView } from '../components/ChatView.tsx';
import { confirmDialog } from '../components/Dialog.tsx';
import { MenuButton, type MenuNode } from '../components/Menu.tsx';
import { toastError } from '../components/toast.tsx';
import { relativeTime } from '../lib/format.ts';
import { usePreference } from '../lib/prefs.ts';
import { useHomeConversations, useWorkspaces } from '../lib/queries.ts';
import { navigate, paths } from '../lib/router.ts';

export function HomePage() {
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const conversations = useHomeConversations();
  const [currentId, setCurrentId] = usePreference<string | null>('nav.homeConversation', null);
  const list = conversations.data ?? [];
  const activeId = currentId && list.some((c) => c.id === currentId) ? currentId : null;
  const missions = workspaces.data?.workspaces ?? [];
  const sections = workspaces.data?.sections ?? [];
  const names = missions.filter((m) => m.hasGoals).map((m) => m.name);
  const cards = (items: typeof missions) =>
    items.map((mission, index) => (
      <button key={mission.id} type="button" className="mission-card" data-tone={index % 3} onClick={() => navigate(paths.mission(mission.slug))}>
        <span className="mission-card-top">
          <span className="mark" aria-hidden="true" />
          <ArrowUpRight size={16} className="go" aria-hidden="true" />
        </span>
        <span className="name">{mission.name}</span>
        <span className="desc">{mission.description}</span>
      </button>
    ));

  const history: MenuNode[] = [
    { id: 'new', label: 'New conversation', icon: <SquarePen size={15} />, onSelect: () => setCurrentId(null) },
  ];
  if (list.length) {
    history.push({ type: 'separator', id: 'sep' }, { type: 'label', id: 'past', label: 'Past conversations' });
    for (const c of list.slice(0, 40)) {
      history.push({ id: c.id, label: c.title, description: relativeTime(c.lastMessageAt ?? c.updatedAt), checked: c.id === activeId, onSelect: () => setCurrentId(c.id) });
    }
  }
  if (activeId) {
    history.push(
      { type: 'separator', id: 'sep-delete' },
      {
        id: 'delete',
        label: 'Delete this conversation',
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () =>
          void (async () => {
            const ok = await confirmDialog({ title: 'Delete this Round Table conversation?', message: 'It will be removed from Theologians. Saved study notes are not affected.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            try {
              await api.delete(`/api/conversations/${activeId}`);
              setCurrentId(null);
              void queryClient.invalidateQueries({ queryKey: ['homeConversations'] });
            } catch (err) {
              toastError(err);
            }
          })(),
      },
    );
  }

  return (
    <div className="home">
      <div className="home-inner">
        {sections.length > 1 ? (
          sections.map((section) => {
            const items = missions.filter((m) => m.sectionId === section.id);
            if (items.length === 0) return null;
            return (
              <div key={section.id} className="section-block">
                <h2 className="section-label">{section.name}</h2>
                <nav className="mission-cards" aria-label={section.name}>
                  {cards(items)}
                </nav>
              </div>
            );
          })
        ) : (
          <nav className="mission-cards" aria-label="Theologians">
            {cards(missions)}
          </nav>
        )}

        <section className="master" aria-labelledby="master-title">
          <header className="master-header">
            <div className="master-heading">
              <h2 id="master-title">Round Table</h2>
              <p className="sub">
                {names.join(', ')} side by side · reads each theologian's study notes · never changes them
              </p>
            </div>
            <MenuButton label="Round Table conversations" nodes={history} className="icon-btn" placement="bottom-end">
              <History size={17} />
            </MenuButton>
          </header>
          <ChatView
            key={activeId ?? 'new'}
            kind="master"
            workspace={null}
            conversationId={activeId}
            newDraftKey="new.home"
            onCreated={setCurrentId}
            compact
            placeholder="Ask all three a question…"
            emptyState={
              <div className="empty-state">
                <p>Bring one question to all three.</p>
                <p className="muted">Each answers in his own voice, then you'll see where they agree and differ. These are AI voices drawn from their writings, not the men themselves.</p>
              </div>
            }
          />
        </section>
      </div>
    </div>
  );
}
