import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import type { SearchHit, WorkspaceDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { Dialog } from '../components/Dialog.tsx';
import { cx, Spinner } from '../components/ui.tsx';
import { relativeTime } from '../lib/format.ts';
import { useConversationList } from '../lib/queries.ts';
import { navigate, paths } from '../lib/router.ts';

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((part, i) => (part.startsWith('«') ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

export function SearchDialog({ workspace }: { workspace: WorkspaceDto }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const recent = useConversationList(workspace.id);

  useEffect(() => {
    const onSearch = (): void => setOpen(true);
    window.addEventListener('theologians:search', onSearch);
    return () => window.removeEventListener('theologians:search', onSearch);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query.trim());
      setActive(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useQuery({
    queryKey: ['search', workspace.id, debounced],
    queryFn: () => api.get<SearchHit[]>(`/api/workspaces/${workspace.id}/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
  });

  const items: SearchHit[] = debounced
    ? (results.data ?? [])
    : (recent.data ?? []).slice(0, 8).map((c) => ({ conversationId: c.id, title: c.title, folderId: c.folderId, snippet: null, messageId: null, matchedIn: 'title', updatedAt: c.lastMessageAt ?? c.updatedAt }));

  const close = (): void => {
    setOpen(false);
    setQuery('');
  };
  const choose = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    close();
    navigate(paths.conversation(workspace.slug, hit.conversationId));
  };

  return (
    <Dialog open={open} onClose={close} title={`Search ${workspace.name}`} size="lg">
      <input
        className="input search-input"
        data-autofocus
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
        aria-label="Search chats"
        placeholder="Search chat titles and messages"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(items[active]);
          }
        }}
      />
      <div className="search-caption">{debounced ? (results.isFetching ? <Spinner label="Searching" /> : `${items.length} result${items.length === 1 ? '' : 's'}`) : 'Recent chats'}</div>
      <ul id={listId} role="listbox" className="search-results" aria-label="Results">
        {items.map((hit, i) => (
          <li
            key={hit.conversationId}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={cx('search-result', i === active && 'active')}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(hit)}
          >
            <div className="search-title">{hit.title}</div>
            {hit.snippet && (
              <div className="search-snippet">
                <Highlighted text={hit.snippet} />
              </div>
            )}
            <div className="search-meta">{relativeTime(hit.updatedAt)}</div>
          </li>
        ))}
      </ul>
      {debounced && results.isSuccess && items.length === 0 && <p className="muted search-empty">No chats in {workspace.name} match “{debounced}”.</p>}
    </Dialog>
  );
}
