'use client';
import { useState, useMemo } from 'react';
import { cn } from '@/lib/cn';

export interface HistoryEntry {
  id: number;
  question: string;
  answer: string;
  sources: { id: number; topic?: string; startTime?: string; endTime?: string; question: string }[];
  createdAt: string;
}

interface Props {
  isOpen:          boolean;
  onClose:         () => void;
  entries:         HistoryEntry[];
  onNewSession:    () => void;
  isNewSession:    boolean;
}

function formatDateGroup(dateStr: string): string {
  const d    = new Date(dateStr);
  const now  = new Date();
  const diff = now.getDate() - d.getDate();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth()    &&
    diff === 0
  ) return 'Today';
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth()    &&
    diff === 1
  ) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export const ChatHistoryPanel = ({ isOpen, onClose, entries, onNewSession, isNewSession }: Props) => {
  const [search,   setSearch]   = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? entries.filter(e => e.question.toLowerCase().includes(q) || e.answer.toLowerCase().includes(q))
      : entries;
  }, [entries, search]);

  // Group by calendar day
  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const e of [...filtered].reverse()) {
      const label = formatDateGroup(e.createdAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(e);
    }
    return map;
  }, [filtered]);

  return (
    <div
      className={cn(
        'absolute inset-0 bg-white z-10 flex flex-col transition-transform duration-300 rounded-xl',
        isOpen ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
        <i className="fas fa-clock-rotate-left text-[var(--accent)] text-sm" />
        <span className="text-[15px] font-bold text-[var(--text)] flex-1">Chat History</span>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-full bg-[var(--surface)] flex items-center justify-center text-[var(--muted)] hover:bg-gray-200 transition-colors"
        >
          <i className="fas fa-xmark text-sm" />
        </button>
      </div>

      {/* New session button */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <button
          onClick={() => { onNewSession(); onClose(); }}
          className={cn(
            'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-[14px] font-semibold transition-colors',
            isNewSession
              ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
              : 'bg-[var(--surface)] text-[var(--text)] border-[var(--border)] hover:bg-purple-50 hover:border-purple-200'
          )}
        >
          <div className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
            isNewSession ? 'bg-white/20' : 'bg-[var(--accent)]'
          )}>
            <i className={cn('fas fa-plus text-[11px]', isNewSession ? 'text-white' : 'text-white')} />
          </div>
          <span>New Session</span>
          {isNewSession && (
            <span className="ml-auto text-[10px] bg-white/20 px-2 py-0.5 rounded-full">Active</span>
          )}
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 shrink-0">
        <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-2">
          <i className="fas fa-magnifying-glass text-[var(--muted)] text-[11px]" />
          <input
            type="text"
            placeholder="Search questions…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] outline-none"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-[var(--muted)] hover:text-[var(--text)]">
              <i className="fas fa-xmark text-[10px]" />
            </button>
          )}
        </div>
      </div>

      {/* History list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-1">
        {groups.size === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 text-[var(--muted)] gap-3 py-8">
            <div className="w-12 h-12 rounded-2xl bg-purple-50 flex items-center justify-center">
              <i className="fas fa-comments text-purple-300 text-xl" />
            </div>
            <p className="text-[13px] text-center">
              {search ? 'No matching questions found.' : 'No questions yet for this lecture.'}
            </p>
          </div>
        ) : (
          Array.from(groups.entries()).map(([label, items]) => (
            <div key={label}>
              <p className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1 py-2">
                {label}
              </p>
              <div className="flex flex-col gap-1">
                {items.map(entry => (
                  <div key={entry.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                    {/* Question row */}
                    <button
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                      className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--surface)] transition-colors"
                    >
                      <div className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
                        <i className="fas fa-user text-blue-400 text-[9px]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--text)] line-clamp-2 leading-snug">
                          {entry.question}
                        </p>
                        <p className="text-[11px] text-[var(--muted)] mt-0.5">{formatTime(entry.createdAt)}</p>
                      </div>
                      <i className={cn(
                        'fas fa-chevron-down text-[var(--muted)] text-[9px] mt-1.5 transition-transform',
                        expanded === entry.id && 'rotate-180'
                      )} />
                    </button>

                    {/* Expanded answer */}
                    {expanded === entry.id && (
                      <div className="border-t border-[var(--border)] bg-purple-50 px-3 py-2.5">
                        <div className="flex items-start gap-2 mb-1.5">
                          <div className="w-5 h-5 rounded-md bg-[var(--accent)] flex items-center justify-center shrink-0 mt-0.5">
                            <i className="fas fa-robot text-white text-[8px]" />
                          </div>
                          <p className="text-[13px] text-[var(--text)] leading-relaxed line-clamp-5">
                            {entry.answer}
                          </p>
                        </div>
                        {entry.sources?.[0]?.topic && (
                          <div className="flex items-center gap-1 mt-1.5">
                            <i className="fas fa-bookmark text-[var(--accent)] text-[8px]" />
                            <span className="text-[11px] text-[var(--accent)] font-medium">
                              {entry.sources[0].topic}
                              {entry.sources[0].startTime ? ` · ${entry.sources[0].startTime}` : ''}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
