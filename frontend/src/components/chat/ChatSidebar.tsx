'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useLazyQuery, useMutation } from '@apollo/client';
import {
  PAGINATED_CHAT_HISTORY_QUERY,
  SEARCH_CHAT_HISTORY_QUERY,
  DELETE_CHAT_ENTRY_MUTATION,
  RENAME_CHAT_ENTRY_MUTATION,
} from '@/graphql/chat.mutations';
import { cn } from '@/lib/cn';

const PAGE_SIZE = 15;

interface HistoryEntry {
  id: number;
  question: string;
  answer: string;
  createdAt: string;
}

interface MenuState {
  id: number;
  top: number;
  right: number;
}

function dateGroup(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 Days';
  if (diffDays <= 30) return 'Previous 30 Days';
  return 'Older';
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const GROUP_ORDER = ['Pinned', 'Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

// ── EntryRow lives at module level so React never sees it as a new component
//    type during re-renders — this is what keeps the rename input focused.
interface EntryRowProps {
  entry:          HistoryEntry;
  label:          string;
  isPinned:       boolean;
  expanded:       number | null;
  renamingId:     number | null;
  renameValue:    string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onToggleExpand: (id: number) => void;
  onOpenMenu:     (e: React.MouseEvent<HTMLButtonElement>, id: number) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: number) => void;
  onRenameCancel: () => void;
}

const EntryRow = ({
  entry, label, isPinned, expanded, renamingId, renameValue, renameInputRef,
  onToggleExpand, onOpenMenu, onRenameChange, onRenameCommit, onRenameCancel,
}: EntryRowProps) => {
  if (renamingId === entry.id) {
    return (
      <div className="rounded-xl border border-[var(--accent)] bg-purple-50 px-3 py-2.5">
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={e => onRenameChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onRenameCommit(entry.id);
            if (e.key === 'Escape') onRenameCancel();
          }}
          className="w-full bg-transparent text-[13px] text-[var(--text)] font-medium outline-none"
          maxLength={120}
        />
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => onRenameCommit(entry.id)}
            className="flex-1 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-semibold hover:bg-indigo-700 transition-colors"
          >
            Save
          </button>
          <button
            onClick={onRenameCancel}
            className="flex-1 py-1 rounded-lg bg-[var(--surface)] text-[var(--muted)] text-[11px] font-semibold hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'group rounded-xl border overflow-hidden',
      isPinned ? 'border-purple-200 bg-purple-50/40' : 'border-[var(--border)]'
    )}>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          onClick={() => onToggleExpand(entry.id)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-start gap-1.5">
            {isPinned && <i className="fas fa-thumbtack text-[var(--accent)] text-[9px] mt-1 shrink-0" />}
            <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug">{label}</p>
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-0.5">{formatTime(entry.createdAt)}</p>
        </button>

        <button
          onClick={e => onOpenMenu(e, entry.id)}
          className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:bg-gray-100 hover:text-[var(--text)] transition-all shrink-0 mt-0.5"
          aria-label="More options"
        >
          <i className="fas fa-ellipsis text-[11px]" />
        </button>
      </div>

      {expanded === entry.id && (
        <div className="border-t border-[var(--border)] bg-white px-3 py-2.5">
          <p className="text-[12px] text-[var(--text)] leading-relaxed line-clamp-6">{entry.answer}</p>
        </div>
      )}
    </div>
  );
};

// ── Main component ───────────────────────────────────────────────────────────

interface Props {
  lectureId:    number;
  onNewChat:    () => void;
  isNewSession: boolean;
  refreshKey:   number;
  onClose:      () => void;
}

export const ChatSidebar = ({ lectureId, onNewChat, isNewSession, refreshKey, onClose }: Props) => {
  const [entries,       setEntries]       = useState<HistoryEntry[]>([]);
  const [total,         setTotal]         = useState(0);
  const [offset,        setOffset]        = useState(0);
  const [loadingMore,   setLoadingMore]   = useState(false);
  const [expanded,      setExpanded]      = useState<number | null>(null);
  const [pinnedIds,     setPinnedIds]     = useState<Set<number>>(new Set());
  const [renamedLabels, setRenamedLabels] = useState<Map<number, string>>(new Map());
  const [renamingId,    setRenamingId]    = useState<number | null>(null);
  const [renameValue,   setRenameValue]   = useState('');
  const [menu,          setMenu]          = useState<MenuState | null>(null);
  const [showSearch,    setShowSearch]    = useState(false);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<HistoryEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const searchTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameInputRef    = useRef<HTMLInputElement>(null);

  // ── Data fetching ────────────────────────────
  const { data: initialData, loading: initialLoading, refetch } = useQuery(
    PAGINATED_CHAT_HISTORY_QUERY,
    { variables: { lectureId, limit: PAGE_SIZE, offset: 0 }, skip: !lectureId, fetchPolicy: 'network-only' }
  );

  useEffect(() => {
    const page = initialData?.paginatedChatHistory;
    if (!page) return;
    setEntries(page.entries);
    setTotal(page.total);
    setOffset(page.entries.length);
  }, [initialData]);

  useEffect(() => {
    if (!lectureId || refreshKey === 0) return;
    refetch({ lectureId, limit: PAGE_SIZE, offset: 0 }).then(({ data }) => {
      const page = data?.paginatedChatHistory;
      if (!page) return;
      setEntries(page.entries);
      setTotal(page.total);
      setOffset(page.entries.length);
    });
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [loadMoreQuery] = useLazyQuery(PAGINATED_CHAT_HISTORY_QUERY, { fetchPolicy: 'network-only' });
  const [searchGql]     = useLazyQuery(SEARCH_CHAT_HISTORY_QUERY,    { fetchPolicy: 'network-only' });
  const [deleteEntry]   = useMutation(DELETE_CHAT_ENTRY_MUTATION);
  const [renameEntry]   = useMutation(RENAME_CHAT_ENTRY_MUTATION);

  // ── Infinite scroll ──────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore || offset >= total) return;
    setLoadingMore(true);
    try {
      const { data } = await loadMoreQuery({ variables: { lectureId, limit: PAGE_SIZE, offset } });
      const page = data?.paginatedChatHistory;
      if (page?.entries?.length) {
        setEntries(prev => [...prev, ...page.entries]);
        setOffset(prev => prev + page.entries.length);
      }
    } finally { setLoadingMore(false); }
  }, [lectureId, loadMoreQuery, loadingMore, offset, total]);

  useEffect(() => {
    const el = bottomSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // ── Debounced search ─────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchGql({ variables: { lectureId, query: searchQuery } });
        setSearchResults(data?.searchChatHistory ?? []);
      } finally { setSearchLoading(false); }
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, lectureId, searchGql]);

  // Focus rename input when rename starts
  useEffect(() => {
    if (renamingId !== null) setTimeout(() => renameInputRef.current?.focus(), 30);
  }, [renamingId]);

  // Close menu on outside click
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  // ── Handlers passed down to EntryRow ─────────
  const handleToggleExpand = useCallback((id: number) => {
    setExpanded(prev => prev === id ? null : id);
  }, []);

  const handleOpenMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>, id: number) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ id, top: rect.bottom + 6, right: window.innerWidth - rect.right });
  }, []);

  const handleRenameChange = useCallback((value: string) => {
    setRenameValue(value);
  }, []);

  const handleRenameCommit = useCallback(async (id: number) => {
    const label = renameValue.trim();
    if (!label) { setRenamingId(null); return; }
    const previous = renamedLabels.get(id);
    setRenamedLabels(prev => new Map(prev).set(id, label));
    setRenamingId(null);
    try {
      await renameEntry({ variables: { id, label } });
    } catch {
      // Revert label if server rejects
      setRenamedLabels(prev => {
        const next = new Map(prev);
        previous ? next.set(id, previous) : next.delete(id);
        return next;
      });
    }
  }, [renameValue, renameEntry, renamedLabels]);

  const handleRenameCancel = useCallback(() => setRenamingId(null), []);

  // ── Menu actions ─────────────────────────────
  const handlePin = (id: number) => {
    setPinnedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setMenu(null);
  };

  const startRename = (id: number) => {
    const current = renamedLabels.get(id) ?? entries.find(e => e.id === id)?.question ?? '';
    setRenameValue(current);
    setRenamingId(id);
    setMenu(null);
  };

  const handleDelete = async (id: number) => {
    // Snapshot for rollback
    const snapshot = [...entries];
    const snapshotTotal = total;
    setEntries(prev => prev.filter(e => e.id !== id));
    setTotal(prev => prev - 1);
    setPinnedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    setMenu(null);
    try {
      await deleteEntry({ variables: { id } });
    } catch {
      // Revert optimistic removal if server rejects
      setEntries(snapshot);
      setTotal(snapshotTotal);
    }
  };

  // ── Grouping ──────────────────────────────────
  const pinned  = entries.filter(e => pinnedIds.has(e.id));
  const regular = entries.filter(e => !pinnedIds.has(e.id));
  const groups: Record<string, HistoryEntry[]> = pinned.length ? { Pinned: pinned } : {};
  for (const e of regular) {
    const g = dateGroup(e.createdAt);
    if (!groups[g]) groups[g] = [];
    groups[g].push(e);
  }

  const renderEntry = (e: HistoryEntry) => (
    <EntryRow
      key={e.id}
      entry={e}
      label={renamedLabels.get(e.id) ?? e.question}
      isPinned={pinnedIds.has(e.id)}
      expanded={expanded}
      renamingId={renamingId}
      renameValue={renameValue}
      renameInputRef={renameInputRef}
      onToggleExpand={handleToggleExpand}
      onOpenMenu={handleOpenMenu}
      onRenameChange={handleRenameChange}
      onRenameCommit={handleRenameCommit}
      onRenameCancel={handleRenameCancel}
    />
  );

  return (
    <>
      {/* Sidebar panel */}
      <div
        className="relative w-[240px] shrink-0 bg-white rounded-xl border border-[var(--border)] shadow-md flex flex-col overflow-hidden"
        style={{ height: 'calc(100vh - 100px)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--border)] shrink-0">
          <span className="text-[14px] font-bold text-[var(--text)] flex-1">History</span>
          <button
            onClick={onClose}
            title="Close sidebar"
            className="w-6 h-6 rounded-lg flex items-center justify-center text-[var(--muted)] hover:bg-gray-100 hover:text-[var(--accent)] transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="5.5" y1="1.5" x2="5.5" y2="14.5" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
          </button>
        </div>

        {/* Action buttons */}
        <div className="px-3 pt-2.5 pb-2 flex flex-col gap-2 shrink-0">
          <button
            onClick={onNewChat}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-[13px] font-semibold transition-colors',
              isNewSession
                ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                : 'bg-[var(--surface)] text-[var(--text)] border-[var(--border)] hover:bg-purple-50 hover:border-purple-200 hover:text-[var(--accent)]'
            )}
          >
            <div className={cn('w-5 h-5 rounded-lg flex items-center justify-center shrink-0', isNewSession ? 'bg-white/20' : 'bg-[var(--accent)]')}>
              <i className="fas fa-plus text-white text-[9px]" />
            </div>
            <span className="flex-1 text-left">New Chat</span>
            {isNewSession && <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full">Active</span>}
          </button>

          <button
            onClick={() => setShowSearch(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[13px] font-medium text-[var(--muted)] hover:bg-gray-100 hover:text-[var(--text)] transition-colors"
          >
            <i className="fas fa-magnifying-glass text-[10px]" />
            <span>Search chats</span>
          </button>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-1">
          {initialLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 py-10 text-[var(--muted)]">
              <div className="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center">
                <i className="fas fa-comments text-purple-300 text-lg" />
              </div>
              <p className="text-[12px] text-center px-2 leading-relaxed">No questions yet.<br />Ask something to get started!</p>
            </div>
          ) : (
            <>
              {GROUP_ORDER.filter(g => groups[g]?.length > 0).map(groupLabel => (
                <div key={groupLabel}>
                  <p className="text-[10px] font-bold text-[var(--muted)] uppercase tracking-wider px-1 py-1.5 select-none">
                    {groupLabel}
                  </p>
                  <div className="flex flex-col gap-1">
                    {groups[groupLabel].map(renderEntry)}
                  </div>
                </div>
              ))}
              <div ref={bottomSentinelRef} className="h-6 flex items-center justify-center py-1">
                {loadingMore && (
                  <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                )}
              </div>
            </>
          )}
        </div>

        {/* Search modal (absolute overlay) */}
        {showSearch && (
          <div className="absolute inset-0 bg-white z-20 flex flex-col rounded-xl">
            <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--border)] shrink-0">
              <div className="flex-1 flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-2">
                <i className="fas fa-magnifying-glass text-[var(--muted)] text-[11px]" />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search your questions…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="flex-1 bg-transparent text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] outline-none min-w-0"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="text-[var(--muted)] hover:text-[var(--text)] shrink-0">
                    <i className="fas fa-xmark text-[10px]" />
                  </button>
                )}
              </div>
              <button
                onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }}
                className="w-8 h-8 rounded-xl bg-[var(--surface)] flex items-center justify-center text-[var(--muted)] hover:bg-gray-200 transition-colors shrink-0"
              >
                <i className="fas fa-xmark text-[12px]" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1">
              {searchLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !searchQuery.trim() ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 py-10 text-[var(--muted)]">
                  <i className="fas fa-magnifying-glass text-3xl text-purple-200" />
                  <p className="text-[12px] text-center px-2 leading-relaxed">
                    Type a keyword to search across all your questions and answers for this lecture.
                  </p>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 py-10 text-[var(--muted)]">
                  <i className="fas fa-face-sad-tear text-2xl text-purple-200" />
                  <p className="text-[12px] text-center px-2">
                    No results for <strong className="text-[var(--text)]">&ldquo;{searchQuery}&rdquo;</strong>
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] text-[var(--muted)] px-1 py-1">
                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </p>
                  {searchResults.map(renderEntry)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Three-dots dropdown — fixed to avoid overflow clipping */}
      {menu && (
        <div
          className="fixed z-[200] bg-white border border-[var(--border)] rounded-xl shadow-xl py-1 w-44"
          style={{ top: menu.top, right: menu.right }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => handlePin(menu.id)}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
          >
            <i className="fas fa-thumbtack text-[var(--muted)] text-[12px] w-4 text-center" />
            {pinnedIds.has(menu.id) ? 'Unpin chat' : 'Pin chat'}
          </button>
          <button
            onClick={() => startRename(menu.id)}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
          >
            <i className="fas fa-pencil text-[var(--muted)] text-[12px] w-4 text-center" />
            Rename
          </button>
          <div className="h-px bg-[var(--border)] my-1" />
          <button
            onClick={() => handleDelete(menu.id)}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
          >
            <i className="fas fa-trash-can text-[12px] w-4 text-center" />
            Delete
          </button>
        </div>
      )}
    </>
  );
};
