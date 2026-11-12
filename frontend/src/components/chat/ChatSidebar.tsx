'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation } from '@apollo/client';
import {
  CHAT_SESSIONS_QUERY,
  DELETE_CHAT_SESSION_MUTATION,
  RENAME_CHAT_SESSION_MUTATION,
} from '@/graphql/chat.mutations';
import { cn } from '@/lib/cn';

const PINNED_KEY = (lectureId: number) => `askaitutor_pinned_sessions_${lectureId}`;

interface Session {
  id:            number;
  title:         string;
  messageCount:  number;
  firstQuestion: string | null;
  createdAt:     string;
  updatedAt:     string;
}

interface MenuState { id: number; top: number; right: number }

/**
 * Whole calendar days between a date and today, in the reader's own timezone.
 * 0 = today, 1 = yesterday, and so on.
 *
 * Elapsed hours are not the same thing as days. A chat from 23:00 last night,
 * opened at 08:00, is 9 hours old but happened yesterday; one from 40 hours ago
 * is not "yesterday" either. Both were mislabelled and sorted into the wrong
 * group while this was measured in seconds.
 */
const COLLAPSED_KEY = 'askaitutor:chat-groups:collapsed';

function daysSince(dateStr: string): number {
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return Number.MAX_SAFE_INTEGER;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);
}

function timeAgo(dateStr: string): string {
  const d    = new Date(dateStr);
  const now  = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  const days = daysSince(dateStr);
  // Minutes and hours only while it is still the same calendar day.
  if (days === 0) {
    if (diff < 60)   return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }
  if (days === 1) return 'Yesterday';
  if (days < 7)   return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function sessionLabel(s: Session): string {
  if (s.title !== 'New Chat') return s.title;
  return s.firstQuestion ?? s.title;
}

interface Props {
  lectureId:        number;
  activeSessionId:  number | null;
  refreshKey:       number;
  onNewChat:        () => void;
  onSelectSession:  (id: number) => void;
  onClose:          () => void;
}

export const ChatSidebar = ({
  lectureId, activeSessionId, refreshKey, onNewChat, onSelectSession, onClose,
}: Props) => {
  const [sessions,      setSessions]     = useState<Session[]>([]);
  const [searchQuery,   setSearchQuery]  = useState('');
  const [showSearch,    setShowSearch]   = useState(false);
  const [menu,          setMenu]         = useState<MenuState | null>(null);
  const [renamingId,    setRenamingId]   = useState<number | null>(null);
  const [renameValue,   setRenameValue]  = useState('');
  const [pinnedIds,     setPinnedIds]    = useState<Set<number>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = localStorage.getItem(PINNED_KEY(lectureId));
      return stored ? new Set(JSON.parse(stored) as number[]) : new Set();
    } catch { return new Set(); }
  });
  const renameInputRef = useRef<HTMLInputElement>(null);

  const { data, loading, refetch } = useQuery(CHAT_SESSIONS_QUERY, {
    variables: { lectureId },
    skip: !lectureId,
    fetchPolicy: 'network-only',
  });

  useEffect(() => {
    const list: Session[] = data?.chatSessions ?? [];
    setSessions(list);
  }, [data]);

  // Re-fetch whenever the parent signals a refresh (new message sent, session created)
  useEffect(() => {
    if (!lectureId || refreshKey === 0) return;
    refetch({ lectureId });
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [deleteSession] = useMutation(DELETE_CHAT_SESSION_MUTATION);
  const [renameSession] = useMutation(RENAME_CHAT_SESSION_MUTATION);

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

  const handleOpenMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>, id: number) => {
    // stopPropagation keeps the outside-click listener from firing for this
    // same click, which is why pressing the button twice used to leave the
    // menu open: the second press simply re-opened it. Toggling here closes it.
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu(prev =>
      prev?.id === id
        ? null
        : { id, top: rect.bottom + 6, right: window.innerWidth - rect.right }
    );
  }, []);

  const startRename = (id: number) => {
    const current = sessions.find(s => s.id === id);
    setRenameValue(sessionLabel(current ?? { id, title: 'New Chat', messageCount: 0, firstQuestion: null, createdAt: '', updatedAt: '' }));
    setRenamingId(id);
    setMenu(null);
  };

  const handleRenameCommit = async (id: number) => {
    const title = renameValue.trim();
    if (!title) { setRenamingId(null); return; }
    // Optimistic update
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s));
    setRenamingId(null);
    try {
      await renameSession({ variables: { id, title } });
    } catch {
      // Revert on failure
      refetch({ lectureId });
    }
  };

  const handleDelete = async (id: number) => {
    const snapshot = [...sessions];
    setSessions(prev => prev.filter(s => s.id !== id));
    setPinnedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    setMenu(null);
    try {
      await deleteSession({ variables: { id } });
      refetch({ lectureId });
    } catch {
      setSessions(snapshot);
    }
  };

  // Persist pin state to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(PINNED_KEY(lectureId), JSON.stringify([...pinnedIds]));
    } catch { /* ignore */ }
  }, [pinnedIds, lectureId]);

  const handlePin = useCallback((id: number) => {
    setPinnedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setMenu(null);
  }, []);

  // Client-side search over session labels
  const filtered = searchQuery.trim()
    ? sessions.filter(s => {
        const q     = searchQuery.toLowerCase();
        const label = sessionLabel(s).toLowerCase();
        return label.includes(q);
      })
    : sessions;

  // Group sessions by pin status then date bucket
  const pinned   = filtered.filter(s => pinnedIds.has(s.id));
  const unpinned = filtered.filter(s => !pinnedIds.has(s.id));

  // Which date groups the student has folded away. Per browser only: there is
  // no per-user UI state in the database, and this is a convenience, not
  // something that must survive a new device.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch { /* storage unavailable, or stored value is not usable */ }
  }, []);

  const toggleGroup = (label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // Grouped on the calendar day the chat was last used, never on how many hours
  // have passed. The previous version read the display string back out of
  // timeAgo() and matched on its wording, so "9h ago" at 8 in the morning was
  // filed under Today even though the chat happened the night before.
  //
  // "Older" is kept as the last bucket and is correct for anything past a
  // month, but it is no longer where everything from three days ago lands:
  // three days and three years used to share one heading.
  const inRange = (lo: number, hi: number) =>
    unpinned.filter(s => { const d = daysSince(s.updatedAt); return d >= lo && d <= hi; });

  const groups: { label: string; items: Session[] }[] = [
    { label: 'Pinned',           items: pinned },
    // Lower bound is open: if a row's time is slightly ahead of the browser
    // clock the chat still shows under Today rather than falling out of every
    // bucket and disappearing from the list.
    { label: 'Today',            items: inRange(Number.MIN_SAFE_INTEGER, 0) },
    { label: 'Yesterday',        items: inRange(1, 1) },
    { label: 'Previous 7 days',  items: inRange(2, 6) },
    { label: 'Previous 30 days', items: inRange(7, 29) },
    { label: 'Older',            items: inRange(30, Number.MAX_SAFE_INTEGER) },
  ].filter(g => g.items.length > 0);

  const renderSession = (s: Session) => {
    const isActive   = s.id === activeSessionId;
    const label      = sessionLabel(s);
    const isRenaming = renamingId === s.id;
    const isPinned   = pinnedIds.has(s.id);

    if (isRenaming) {
      return (
        <div key={s.id} className="rounded-card border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2.5">
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  handleRenameCommit(s.id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            className="w-full bg-transparent text-[13px] text-[var(--text)] font-medium outline-none"
            maxLength={120}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => handleRenameCommit(s.id)}
              className="flex-1 py-1 rounded-control bg-[var(--accent)] text-white text-[11px] font-semibold hover:bg-[var(--accent-deep)] transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setRenamingId(null)}
              className="flex-1 py-1 rounded-control bg-[var(--surface)] text-[var(--muted)] text-[11px] font-semibold hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={s.id}
        onClick={() => onSelectSession(s.id)}
        className={cn(
          'group rounded-card border px-3 py-2.5 cursor-pointer transition-colors',
          isActive
            ? 'bg-[var(--accent-soft)] border-[var(--border)]'
            : isPinned
              ? 'border-[var(--border)] bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]'
              : 'border-[var(--border)] hover:bg-[var(--surface)]'
        )}
      >
        {/* No status dot. The open chat is already shown by its tinted row and
            its green title; a third marker for the same fact read as
            decoration. */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-1">
              {isPinned && (
                <i className="fas fa-thumbtack text-[var(--accent)] text-[9px] mt-1 shrink-0" />
              )}
              <p
                title={label}
                className={cn(
                  'text-[13px] font-medium line-clamp-2 leading-snug',
                  isActive ? 'text-[var(--accent)]' : 'text-[var(--text)]'
                )}
              >
                {label}
              </p>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="text-[11px] text-[var(--muted)]">{timeAgo(s.updatedAt)}</p>
              {s.messageCount > 0 && (
                <>
                  <span className="text-[var(--border)]">·</span>
                  <p className="text-[11px] text-[var(--muted)]">{s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}</p>
                </>
              )}
            </div>
          </div>
          {/* Always visible. Hidden until hover, nothing showed a student that
              a chat can be pinned, renamed or deleted at all — and on a touch
              screen there is no hover to reveal it with. */}
          <button
            onClick={e => handleOpenMenu(e, s.id)}
            className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--muted2)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors shrink-0 mt-0.5"
            aria-label="More options"
          >
            <i className="fas fa-ellipsis text-[11px]" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="relative w-[240px] shrink-0 border-l border-[var(--border)] flex flex-col overflow-hidden h-full">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--border)] shrink-0">
          <span className="text-[14px] font-bold text-[var(--text)] flex-1">Chats</span>
          <button
            onClick={onClose}
            title="Close sidebar"
            className="w-6 h-6 rounded-control flex items-center justify-center text-[var(--muted)] hover:bg-gray-100 hover:text-[var(--accent)] transition-colors"
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
            className="w-full flex items-center gap-2 px-3 py-2 rounded-card border bg-[var(--surface)] text-[var(--text)] border-[var(--border)] hover:bg-[var(--accent-soft)] hover:border-[var(--border)] hover:text-[var(--accent)] text-[13px] font-semibold transition-colors"
          >
            {/* A plain plus at the same weight as the magnifier below. The
                filled navy tile made two buttons of identical shape look like
                two different kinds of control. */}
            <i className="fas fa-plus text-[10px] shrink-0" />
            <span className="flex-1 text-left">New Chat</span>
          </button>

          <button
            onClick={() => setShowSearch(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-card border border-[var(--border)] bg-[var(--surface)] text-[13px] font-semibold text-[var(--muted)] hover:bg-gray-100 hover:text-[var(--text)] transition-colors"
          >
            <i className="fas fa-magnifying-glass text-[10px]" />
            <span>Search Chats</span>
          </button>
        </div>

        {/* Sessions list */}
        <div className="chat-sidebar-scroll flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-1">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 py-10 text-[var(--muted)]">
              <div className="w-10 h-10 rounded-card bg-[var(--accent-soft)] flex items-center justify-center">
                <i className="fas fa-comments text-[var(--muted2)] text-lg" />
              </div>
              <p className="text-[12px] text-center px-2 leading-relaxed">
                No conversations yet.<br />Ask something to get started!
              </p>
            </div>
          ) : (
            groups.map(group => {
              const isOpen = !collapsed.has(group.label);
              return (
                <div key={group.label}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={isOpen}
                    title={isOpen ? `Hide ${group.label.toLowerCase()}` : `Show ${group.label.toLowerCase()}`}
                    className="w-full flex items-center gap-1.5 px-1 py-1.5 rounded-control text-[10px] font-bold text-[var(--muted)] uppercase tracking-wider select-none transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)]"
                  >
                    <i
                      className={cn(
                        'fas fa-chevron-down text-[8px] transition-transform',
                        !isOpen && '-rotate-90'
                      )}
                    />
                    <span>{group.label}</span>
                    <span className="ml-auto font-semibold normal-case tracking-normal text-[var(--muted2)]">
                      {group.items.length}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-1">
                      {group.items.map(renderSession)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Search overlay */}
        {showSearch && (
          <div className="absolute inset-0 bg-white z-20 flex flex-col">
            <div className="flex flex-col gap-2 px-3 py-3 border-b border-[var(--border)] shrink-0">
              {/* Back to history */}
              <button
                onClick={() => { setShowSearch(false); setSearchQuery(''); }}
                className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--accent)] hover:text-[var(--accent-deep)] transition-colors w-fit"
              >
                <i className="fas fa-arrow-left text-[10px]" />
                Back to History
              </button>
              {/* Search input */}
              <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-card px-3 py-2">
                <i className="fas fa-magnifying-glass text-[var(--muted)] text-[11px]" />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search conversations…"
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
            </div>

            <div className="chat-sidebar-scroll flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1">
              {filtered.length === 0 && searchQuery.trim() ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 py-10 text-[var(--muted)]">
                  <i className="fas fa-face-sad-tear text-2xl text-[var(--muted2)]" />
                  <p className="text-[12px] text-center px-2">
                    No results for <strong className="text-[var(--text)]">&ldquo;{searchQuery}&rdquo;</strong>
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {searchQuery.trim() && (
                    <p className="text-[11px] text-[var(--muted)] px-1 py-1">
                      {filtered.length} result{filtered.length !== 1 ? 's' : ''}
                    </p>
                  )}
                  {filtered.map(s => (
                    <div
                      key={s.id}
                      onClick={() => {
                        onSelectSession(s.id);
                        setShowSearch(false);
                        setSearchQuery('');
                      }}
                      className={cn(
                        'rounded-card border px-3 py-2.5 cursor-pointer transition-colors',
                        s.id === activeSessionId
                          ? 'bg-[var(--accent-soft)] border-[var(--border)]'
                          : 'border-[var(--border)] hover:bg-[var(--surface)]'
                      )}
                    >
                      <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug">
                        {sessionLabel(s)}
                      </p>
                      <p className="text-[11px] text-[var(--muted)] mt-0.5">{timeAgo(s.updatedAt)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Context menu — fixed so it isn't clipped by overflow:hidden */}
      {menu && (
        <div
          className="fixed z-[200] bg-white border border-[var(--border)] rounded-card shadow-xl py-1 w-44"
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
