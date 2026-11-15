'use client';
import { componentLabel } from '@/lib/monitor-labels';
import type { ReadinessResult } from './monitor-api';

type Level = 'ok' | 'warn' | 'down' | 'unknown';

// Mirrors health.service.ts requiredComponents(): any of these being unhealthy
// stops students from getting answers.
const REQUIRED = ['database', 'pgvector', 'embeddingServer', 'reranker', 'answerLlm'];

const joinNames = (names: string[]) => names.join(' and ');

export function describeHealth(h: ReadinessResult | null): { level: Level; text: string; notes: string[]; checked: string[] } {
  if (!h) return { level: 'unknown', text: 'Health check could not be loaded', notes: [], checked: [] };
  const entries = Object.entries(h.components ?? {});
  if (entries.length === 0) {
    return h.status === 'unhealthy'
      ? { level: 'down', text: 'Health check failed. Students are not getting answers.', notes: [], checked: [] }
      : { level: 'unknown', text: 'Health check could not be loaded', notes: [], checked: [] };
  }

  // "degraded" from this endpoint means "not verified" — a check that only
  // confirmed configuration — not a problem, just something we can't confirm.
  //
  // This used to be defined as degraded with NO error code, but the backend
  // returns degraded WITH the code UNVERIFIED_PROVIDER for exactly this case
  // (health.service.ts: "never `healthy` for something that wasn't checked").
  // So an answer model whose adapter has no free probe fell through to `shaky`
  // below and this banner reported "having problems" permanently, about a model
  // answering every question correctly. Both spellings now count as unverified.
  const isUnverified = (c: { status: string; errorCode?: string }) =>
    c.status === 'degraded' && (!c.errorCode || c.errorCode === 'UNVERIFIED_PROVIDER');

  const unverified = entries
    .filter(([, c]) => isUnverified(c))
    .map(([k]) => `${componentLabel(k)} connectivity not checked`);

  // What "everything" stands for. The line claimed all is well without ever
  // saying what had been looked at.
  const checked = entries.map(([k]) => componentLabel(k));

  const down = entries.filter(([k, c]) => c.status === 'unhealthy' && REQUIRED.includes(k)).map(([k]) => componentLabel(k));
  if (down.length > 0) {
    return { level: 'down', text: `${joinNames(down)} ${down.length > 1 ? 'are' : 'is'} down. Students are not getting answers.`, notes: unverified, checked };
  }
  if (h.status === 'unhealthy') {
    const names = entries.filter(([, c]) => c.status === 'unhealthy').map(([k]) => componentLabel(k));
    return { level: 'down', text: `${joinNames(names.length ? names : ['A required service'])} ${names.length > 1 ? 'are' : 'is'} down. Students are not getting answers.`, notes: unverified, checked };
  }

  const shaky = entries
    .filter(([, c]) => c.status === 'unhealthy' || (c.status === 'degraded' && !isUnverified(c)))
    .map(([k]) => componentLabel(k));
  if (shaky.length > 0) {
    return { level: 'warn', text: `${joinNames(shaky)} ${shaky.length > 1 ? 'are' : 'is'} having problems. Students still get answers.`, notes: unverified, checked };
  }
  return { level: 'ok', text: 'Everything the tutor needs is working', notes: unverified, checked };
}

/**
 * Working is the state this is in nearly all the time, and a full-width white
 * box holding three words is a lot of the screen spent saying "nothing is
 * wrong". It is a line of text with a dot in front of it. A real problem gets
 * the gold the rest of the admin uses, and is the only time it is loud.
 */
const DOT: Record<Level, string> = {
  ok: 'bg-[var(--accent)]',
  warn: 'bg-[var(--gold)]',
  down: 'bg-[var(--gold)]',
  unknown: 'bg-[var(--muted2)]',
};

export function StatusBanner({ health, loading, checkedAt }: {
  health: ReadinessResult | null; loading: boolean; checkedAt?: Date | null;
}) {
  if (loading && !health) {
    return <div className="h-5 w-64 rounded bg-[var(--surface)] animate-pulse mb-5" aria-hidden="true" />;
  }
  const { level, text, notes, checked } = describeHealth(health);
  const problem = level === 'warn' || level === 'down';
  return (
    <div className="mb-5">
      <p role="status" className="flex items-center gap-2.5 text-label">
        <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[level]}`} aria-hidden="true" />
        <span className={problem ? 'font-semibold text-[var(--gold)]' : 'text-[var(--text)]'}>{text}</span>
        {checkedAt && !problem && (
          <span className="text-caption text-[var(--muted2)]">· checked {checkedAt.toLocaleTimeString()}</span>
        )}
      </p>
      {/* The parts that were checked, so "everything" names itself. */}
      {level === 'ok' && checked.length > 0 && (
        <p className="text-caption text-[var(--muted)] mt-1 ml-[18px]">Checked: {checked.join(', ')}</p>
      )}
      {notes.map((n) => (
        <p key={n} className="text-caption text-[var(--muted2)] mt-1 ml-[18px]">{n}</p>
      ))}
    </div>
  );
}
