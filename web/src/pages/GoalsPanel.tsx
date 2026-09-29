import { useQueryClient } from '@tanstack/react-query';
import { Info, Plus, Target, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { categoryLabel, certaintyLabel, MEMORY_CATEGORIES, MEMORY_CERTAINTIES } from '../../../shared/constants.ts';
import type { ConversationDto, MemoryCategory, MemoryCertainty, MemoryChangeDto, MemoryItemDto, MemoryProposalDto, WorkspaceDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { ChatView } from '../components/ChatView.tsx';
import { MenuButton } from '../components/Menu.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { Button, cx, IconButton, Segmented, Spinner, Switch } from '../components/ui.tsx';
import { relativeTime } from '../lib/format.ts';
import { prefillComposer } from '../lib/prefill.ts';
import { useChanges, useGoalsConversation, useMemory, useProposals } from '../lib/queries.ts';
import { navigate, paths } from '../lib/router.ts';
import { shortcut } from '../lib/shortcuts.ts';

type Tab = 'chat' | 'memory' | 'updates';

function useRefreshMemory(workspaceId: string) {
  const queryClient = useQueryClient();
  return (): void => {
    for (const key of ['memory', 'proposals', 'changes']) void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
  };
}

function GoalsChat({ workspace }: { workspace: WorkspaceDto }) {
  const conversation = useGoalsConversation(workspace.id);
  if (conversation.isPending) {
    return (
      <div className="chat-loading">
        <Spinner />
      </div>
    );
  }
  if (conversation.isError) return <div className="empty-state">The Study conversation couldn't be loaded.</div>;
  return (
    <ChatView
      kind="goals"
      workspace={workspace}
      conversationId={conversation.data.id}
      compact
      placeholder={`Talk with ${workspace.name} about your study`}
      prefillTarget={`goals:${workspace.id}`}
      emptyState={
        <div className="empty-state compact">
          <p>Step back and think about {workspace.name}: where you're headed, what you're focusing on, and how it's going.</p>
          <p className="muted">{workspace.name} Goals reads this mission's saved memory. When something seems worth remembering, it suggests a change for you to review.</p>
        </div>
      }
    />
  );
}

function MemoryEditor({
  initialText,
  initialCertainty,
  onSave,
  onCancel,
}: {
  initialText: string;
  initialCertainty: MemoryCertainty;
  onSave: (text: string, certainty: MemoryCertainty) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [certainty, setCertainty] = useState(initialCertainty);
  const [busy, setBusy] = useState(false);
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(text.trim(), certainty);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="memory-editor" onSubmit={(e) => void submit(e)}>
      <textarea
        className="textarea"
        rows={2}
        value={text}
        aria-label="Memory text"
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="memory-editor-bar">
        <select className="select sm" value={certainty} aria-label="Certainty" onChange={(e) => setCertainty(e.target.value as MemoryCertainty)}>
          {MEMORY_CERTAINTIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!text.trim() || busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

function MemoryItemRow({ item, workspace }: { item: MemoryItemDto; workspace: WorkspaceDto }) {
  const [editing, setEditing] = useState(false);
  const refresh = useRefreshMemory(workspace.id);
  const patch = async (body: Record<string, unknown>): Promise<void> => {
    await api.patch(`/api/memory/items/${item.id}`, { ...body, expectedVersion: item.version });
    refresh();
  };
  if (editing) {
    return (
      <li className="memory-item editing">
        <MemoryEditor
          initialText={item.text}
          initialCertainty={item.certainty}
          onCancel={() => setEditing(false)}
          onSave={async (text, certainty) => {
            await patch({ text, certainty });
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="memory-item">
      <button type="button" className="memory-text" onClick={() => setEditing(true)} title="Edit">
        {item.text}
      </button>
      <div className="memory-item-meta">
        <MenuButton
          label={`Certainty: ${certaintyLabel(item.certainty)}. Change`}
          className={cx('certainty', item.certainty)}
          nodes={MEMORY_CERTAINTIES.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
            checked: c.id === item.certainty,
            onSelect: () => void patch({ certainty: c.id }).catch(toastError),
          }))}
        >
          {certaintyLabel(item.certainty)}
        </MenuButton>
        {item.origin !== 'user' && (
          <span className="origin" title={item.sourceTitle ? `From “${item.sourceTitle}”` : undefined}>
            {item.origin === 'autosave' ? 'autosaved' : item.origin === 'approved' ? 'approved' : 'imported'}
          </span>
        )}
        <IconButton
          size="sm"
          label="Delete"
          className="memory-delete"
          onClick={() =>
            void api
              .delete(`/api/memory/items/${item.id}`)
              .then(() => {
                refresh();
                toast('Deleted. You can undo this under Updates → History.');
              })
              .catch(toastError)
          }
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
    </li>
  );
}

function MemorySection({ category, items, workspace }: { category: (typeof MEMORY_CATEGORIES)[number]; items: MemoryItemDto[]; workspace: WorkspaceDto }) {
  const [adding, setAdding] = useState(false);
  const refresh = useRefreshMemory(workspace.id);
  const headingId = `memory-${workspace.id}-${category.id}`;
  return (
    <section className="memory-section" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <span>{category.label}</span>
        <IconButton size="sm" label={`Add ${category.singular}`} onClick={() => setAdding(true)}>
          <Plus size={14} />
        </IconButton>
      </h3>
      {items.length === 0 && !adding && <p className="memory-empty">Nothing saved.</p>}
      {items.length > 0 && (
        <ul className="memory-list">
          {items.map((item) => (
            <MemoryItemRow key={item.id} item={item} workspace={workspace} />
          ))}
        </ul>
      )}
      {adding && (
        <MemoryEditor
          initialText=""
          initialCertainty="confirmed"
          onCancel={() => setAdding(false)}
          onSave={async (text, certainty) => {
            await api.post(`/api/workspaces/${workspace.id}/memory/items`, { category: category.id as MemoryCategory, certainty, text });
            refresh();
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

function MemoryView({ workspace }: { workspace: WorkspaceDto }) {
  const memory = useMemory(workspace.id);
  const refresh = useRefreshMemory(workspace.id);
  const [showMore, setShowMore] = useState(false);
  if (memory.isPending) {
    return (
      <div className="chat-loading">
        <Spinner />
      </div>
    );
  }
  if (memory.isError) return <div className="empty-state">Memory couldn't be loaded.</div>;
  const data = memory.data;
  const secondary = MEMORY_CATEGORIES.filter((c) => !c.primary);
  const secondaryCount = data.items.filter((i) => secondary.some((c) => c.id === i.category)).length;
  return (
    <div className="memory">
      <div className="memory-autosave">
        <div className="text">
          <div className="title">Autosave important updates</div>
          <div className="hint">
            {data.autosave ? 'On — important additions and edits are saved right away and listed under Updates, where you can undo them.' : 'Off — every suggested change waits for your approval.'}
          </div>
        </div>
        <Switch
          label="Autosave important memory updates"
          checked={data.autosave}
          onChange={(value) =>
            void api
              .patch(`/api/workspaces/${workspace.id}/settings`, { memoryAutosave: value })
              .then(refresh)
              .catch(toastError)
          }
        />
      </div>
      {MEMORY_CATEGORIES.filter((c) => c.primary).map((category) => (
        <MemorySection key={category.id} category={category} items={data.items.filter((i) => i.category === category.id)} workspace={workspace} />
      ))}
      <button type="button" className="link-button more-toggle" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
        {showMore ? 'Hide ideas, feelings, constraints, and notes' : `Ideas, feelings, constraints, and notes${secondaryCount ? ` (${secondaryCount})` : ''}`}
      </button>
      {showMore &&
        secondary.map((category) => <MemorySection key={category.id} category={category} items={data.items.filter((i) => i.category === category.id)} workspace={workspace} />)}
      <p className="memory-footnote">{data.lastChangedAt ? `Last changed ${relativeTime(data.lastChangedAt)}.` : 'Nothing saved yet.'} Stored on this computer.</p>
    </div>
  );
}

function ProposalCard({ proposal, workspace }: { proposal: MemoryProposalDto; workspace: WorkspaceDto }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshMemory(workspace.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.text ?? '');
  const [busy, setBusy] = useState(false);
  const opLabel =
    proposal.op === 'add'
      ? `Add to ${proposal.category ? categoryLabel(proposal.category) : 'memory'}`
      : proposal.op === 'update'
        ? `Update ${proposal.category ? categoryLabel(proposal.category).toLowerCase() : 'saved item'}`
        : 'Remove saved item';

  const decide = async (action: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/api/memory/proposals/${proposal.id}/${action}`, action === 'approve' && editing ? { text } : {});
      refresh();
    } catch (err) {
      toastError(err);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const goalsId = queryClient.getQueryData<ConversationDto>(['goalsConversation', workspace.id])?.id;
  const fromGoalsChat = goalsId !== undefined && goalsId === proposal.sourceConversationId;
  const openSource = (): void => {
    if (!proposal.sourceConversationId) return;
    if (fromGoalsChat) window.dispatchEvent(new CustomEvent('theologians:open-goals', { detail: { tab: 'chat' } }));
    else navigate(paths.conversation(workspace.slug, proposal.sourceConversationId));
  };

  return (
    <article className="proposal" aria-label={opLabel}>
      <div className="proposal-head">
        <span className="op">{opLabel}</span>
        {proposal.certainty && <span className={cx('certainty', 'static', proposal.certainty)}>{certaintyLabel(proposal.certainty)}</span>}
        {proposal.importance === 'high' && <span className="importance">important</span>}
      </div>
      {proposal.op !== 'add' && proposal.targetText && (
        <p className="proposal-current">
          <span className="muted">{proposal.op === 'remove' ? 'Saved:' : 'Now:'}</span> {proposal.targetText}
        </p>
      )}
      {proposal.op !== 'remove' &&
        (editing ? (
          <textarea className="textarea" rows={2} value={text} aria-label="Edit suggestion before approving" autoFocus onChange={(e) => setText(e.target.value)} />
        ) : (
          <p className="proposal-text">{proposal.text}</p>
        ))}
      {proposal.reason && <p className="proposal-reason">{proposal.reason}</p>}
      {proposal.evidence && <blockquote className="proposal-evidence">“{proposal.evidence}”</blockquote>}
      {proposal.statusDetail && (
        <p className="proposal-detail">
          <Info size={12} aria-hidden="true" /> {proposal.statusDetail}
        </p>
      )}
      <div className="proposal-source">
        {proposal.sourceKind === 'goals_assistant' ? `Suggested by ${workspace.name} in ` : 'From a review of '}
        <button type="button" className="link-button" onClick={openSource}>
          {fromGoalsChat ? 'the study chat' : `“${proposal.sourceTitle ?? 'a conversation'}”`}
        </button>{' '}
        · {relativeTime(proposal.createdAt)}
      </div>
      <div className="proposal-actions">
        {proposal.op !== 'remove' && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel edit' : 'Edit'}
          </Button>
        )}
        <span className="spacer" />
        <Button size="sm" disabled={busy} onClick={() => void decide('reject')}>
          Reject
        </Button>
        <Button size="sm" variant="primary" disabled={busy || (editing && !text.trim())} onClick={() => void decide('approve')}>
          {proposal.op === 'remove' ? 'Remove' : 'Approve'}
        </Button>
      </div>
    </article>
  );
}

const ORIGIN_LABELS: Record<MemoryChangeDto['origin'], string> = {
  user_edit: 'You',
  proposal_approved: 'Approved',
  autosave: 'Autosaved',
  undo: 'Undo',
  import: 'Imported',
};

function UpdatesView({ workspace }: { workspace: WorkspaceDto }) {
  const proposals = useProposals(workspace.id);
  const changes = useChanges(workspace.id);
  const refresh = useRefreshMemory(workspace.id);
  const pending = (proposals.data ?? []).filter((p) => p.status === 'pending');
  return (
    <div className="updates">
      <section aria-labelledby={`review-${workspace.id}`}>
        <h3 id={`review-${workspace.id}`} className="updates-heading">
          Waiting for your review{pending.length ? ` (${pending.length})` : ''}
        </h3>
        {proposals.isPending ? (
          <Spinner />
        ) : pending.length === 0 ? (
          <p className="memory-empty">Nothing to review. Suggestions from {workspace.name} conversations appear here.</p>
        ) : (
          pending.map((p) => <ProposalCard key={p.id} proposal={p} workspace={workspace} />)
        )}
      </section>
      <section aria-labelledby={`history-${workspace.id}`}>
        <h3 id={`history-${workspace.id}`} className="updates-heading">
          History
        </h3>
        {changes.isSuccess && changes.data.length === 0 && <p className="memory-empty">No memory changes yet.</p>}
        <ul className="history">
          {(changes.data ?? []).map((change) => (
            <li key={change.id} className="history-row">
              <span className={cx('origin-badge', change.origin)}>{ORIGIN_LABELS[change.origin]}</span>
              <div className="history-text">
                <span>{change.summary}</span>
                <span className="muted">
                  {relativeTime(change.createdAt)}
                  {change.undoneByChangeId ? ' · undone' : ''}
                </span>
              </div>
              {!change.undoneByChangeId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void api
                      .post(`/api/memory/changes/${change.id}/undo`)
                      .then(refresh)
                      .catch(toastError)
                  }
                >
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CheckinBanner({ workspace, onStart }: { workspace: WorkspaceDto; onStart: () => void }) {
  const refresh = useRefreshMemory(workspace.id);
  return (
    <div className="checkin" role="note">
      <p>Want to take a few minutes to reflect on {workspace.name}?</p>
      <div className="checkin-actions">
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void api
              .post<{ prompt: string }>(`/api/workspaces/${workspace.id}/checkin/start`)
              .then((result) => {
                onStart();
                prefillComposer(`goals:${workspace.id}`, result.prompt);
                refresh();
              })
              .catch(toastError)
          }
        >
          Start check-in
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void api.post(`/api/workspaces/${workspace.id}/checkin/snooze`).then(refresh).catch(toastError)}>
          Not now
        </Button>
      </div>
    </div>
  );
}

export function GoalsPanel({
  workspace,
  width,
  overlay,
  tab,
  onTab,
  onClose,
}: {
  workspace: WorkspaceDto;
  width: number;
  overlay: boolean;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onClose: () => void;
}) {
  const memory = useMemory(workspace.id);
  const proposals = useProposals(workspace.id);
  const pending = proposals.data ? proposals.data.filter((p) => p.status === 'pending').length : (memory.data?.pendingCount ?? 0);
  return (
    <aside className={cx('goals-panel', overlay && 'overlay')} style={{ width }} aria-label={`${workspace.name} study notes`}>
      <div className="panel-header">
        <div className="panel-title">
          <Target size={15} aria-hidden="true" />
          <span className="truncate">{workspace.name} Goals</span>
        </div>
        <IconButton size="sm" label="Close study notes" shortcut={shortcut('J')} onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="panel-tabs">
        <Segmented<Tab>
          label="Study notes section"
          value={tab}
          onChange={onTab}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'memory', label: 'Memory' },
            { value: 'updates', label: 'Updates', badge: pending ? <span className="tab-count" aria-label={`${pending} waiting for review`}>{pending}</span> : undefined },
          ]}
        />
      </div>
      {memory.data?.checkin.due && <CheckinBanner workspace={workspace} onStart={() => onTab('chat')} />}
      <div className="panel-body">
        {tab === 'chat' && <GoalsChat workspace={workspace} />}
        {tab === 'memory' && <MemoryView workspace={workspace} />}
        {tab === 'updates' && <UpdatesView workspace={workspace} />}
      </div>
    </aside>
  );
}
