'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { MY_NOTIFICATIONS_QUERY, MARK_NOTIFICATIONS_READ } from '@/graphql/notification.queries';
import { cn } from '@/lib/cn';

/**
 * Notification bell.
 *
 * Reads stored notifications from the `notifications` table. Two earlier
 * versions were worse: the first had "0 new" and "No recent notifications"
 * written into the markup with no query at all, and the second derived items
 * from lecture timestamps, which meant read state lived in one browser and a
 * title edit re-announced the lecture.
 *
 * Now a row is written per student when a lecture is added and again when its
 * tutor becomes ready, and read state is a column on that row — so it is the
 * same on every device, and nothing can be announced twice.
 */

const PAGE = 10;

const ICON: Record<string, string> = {
  TUTOR_READY:   'fas fa-circle-check',
  LECTURE_ADDED: 'fas fa-clock',
};

interface Notification {
  id:        number;
  type:      string;
  title:     string;
  body:      string;
  lectureId: number | null;
  read:      boolean;
  createdAt: string;
}

/** "just now", "23 hours ago", "2 days ago". */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const NotificationBell = () => {
  const [open, setOpen] = useState(false);
  // What was unread when the panel was opened. Opening marks everything read,
  // so without holding this the highlight would clear before it could be seen.
  const [unreadOnOpen, setUnreadOnOpen] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  const { data, loading } = useQuery(MY_NOTIFICATIONS_QUERY, {
    variables: { limit: PAGE, offset: 0 },
    // Poll so a lecture made ready while the student is on the page shows up
    // without a reload. Two minutes: often enough to feel live, rare enough
    // not to matter.
    pollInterval: 120000,
    fetchPolicy: 'cache-and-network',
  });

  const [markRead] = useMutation(MARK_NOTIFICATIONS_READ);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const page   = data?.myNotifications;
  const items  = (page?.items ?? []) as Notification[];
  const unread = page?.unread ?? 0;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;

    // Remember which ones were unread, then mark them read on the server. The
    // list keeps its highlight for as long as the panel stays open.
    setUnreadOnOpen(new Set(items.filter(i => !i.read).map(i => i.id)));
    if (unread > 0) {
      try {
        await markRead({ variables: { ids: null } });
      } catch {
        // A failed mark is not worth interrupting the student for; the count
        // simply stays until the next attempt.
      }
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        // No tile and no border. The bell is a header control like the two
        // nav links beside it, and those are plain text — a bordered box made
        // it the heaviest thing in the bar.
        className={cn(
          'relative w-9 h-9 flex items-center justify-center transition-colors',
          open ? 'text-white' : 'text-white/70 hover:text-white'
        )}
      >
        <i className="fas fa-bell text-[17px]" />
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[var(--accent-dim)] text-[var(--ink)] text-[10px] font-bold flex items-center justify-center leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] w-80 bg-white rounded-card border border-[var(--border)] shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <span className="text-label font-semibold text-[var(--text)]">Notifications</span>
            <span className="text-caption text-[var(--muted)]">
              {page ? (page.total === 0 ? 'none' : `${page.total}`) : '…'}
            </span>
          </div>

          {loading && !page ? (
            <div className="py-10 text-center">
              <span className="inline-block w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 px-6">
              <i className="fas fa-bell-slash text-[var(--muted2)] text-[20px]" />
              <p className="text-caption text-[var(--muted)] text-center">
                Nothing yet. You will be told here when a lecture is added or its tutor becomes ready.
              </p>
            </div>
          ) : (
            <ul className="max-h-[360px] overflow-y-auto">
              {items.map(n => {
                const isNew = unreadOnOpen.has(n.id);
                const body = (
                  <>
                    <span className="w-7 h-7 rounded-control bg-[var(--surface)] flex items-center justify-center shrink-0 mt-0.5">
                      <i
                        className={cn(
                          'text-caption',
                          ICON[n.type] ?? 'fas fa-circle-info',
                          n.type === 'TUTOR_READY' ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-label font-medium text-[var(--text)]">{n.title}</span>
                      <span className="block text-caption text-[var(--muted)] mt-0.5 line-clamp-2">{n.body}</span>
                      <span className="block text-caption text-[var(--muted2)] mt-1">{relative(n.createdAt)}</span>
                    </span>
                    {isNew && (
                      <span
                        className="w-2 h-2 rounded-full bg-[var(--accent)] shrink-0 mt-2"
                        title="New since you last looked"
                      />
                    )}
                  </>
                );

                const rowClass = cn(
                  'flex gap-3 px-4 py-3 transition-colors',
                  isNew && 'bg-[var(--accent-soft)]'
                );

                return (
                  <li key={n.id} className="border-b border-[var(--border)] last:border-b-0">
                    {n.lectureId ? (
                      <Link
                        href={`/lecture/${n.lectureId}`}
                        onClick={() => setOpen(false)}
                        className={cn(rowClass, 'hover:bg-[var(--surface)]')}
                      >
                        {body}
                      </Link>
                    ) : (
                      // A notification that points at no lecture is not a link.
                      <div className={rowClass}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
