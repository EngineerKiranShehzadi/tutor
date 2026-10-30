'use client';
import { componentLabel } from '@/lib/monitor-labels';
import type { ReadinessResult } from './monitor-api';

type Level = 'ok' | 'warn' | 'down' | 'unknown';

// Mirrors health.service.ts: only these three being unhealthy stops
// students from getting answers; reranker / gemini failing is "degraded".
const REQUIRED = ['database', 'pgvector', 'embeddingServer'];

const joinNames = (names: string[]) => names.join(' and ');

export function describeHealth(h: ReadinessResult | null): { level: Level; text: string; notes: string[] } {
  if (!h) return { level: 'unknown', text: 'Health check could not be loaded', notes: [] };
  const entries = Object.entries(h.components ?? {});
  if (entries.length === 0) {
    return h.status === 'unhealthy'
      ? { level: 'down', text: 'Health check failed — students are not getting answers', notes: [] }
      : { level: 'unknown', text: 'Health check could not be loaded', notes: [] };
  }

  // "degraded" with no errorCode means "not verified" (e.g. the Gemini
  // check is disabled) — not a problem, just something we can't confirm.
  const unverified = entries
    .filter(([, c]) => c.status === 'degraded' && !c.errorCode)
    .map(([k]) => `${componentLabel(k)} connectivity not checked`);

  const down = entries.filter(([k, c]) => c.status === 'unhealthy' && REQUIRED.includes(k)).map(([k]) => componentLabel(k));
  if (down.length > 0) {
    return { level: 'down', text: `${joinNames(down)} ${down.length > 1 ? 'are' : 'is'} down — students are not getting answers`, notes: unverified };
  }
  if (h.status === 'unhealthy') {
    const names = entries.filter(([, c]) => c.status === 'unhealthy').map(([k]) => componentLabel(k));
    return { level: 'down', text: `${joinNames(names.length ? names : ['A required service'])} ${names.length > 1 ? 'are' : 'is'} down — students are not getting answers`, notes: unverified };
  }

  const shaky = entries
    .filter(([, c]) => c.status === 'unhealthy' || (c.status === 'degraded' && !!c.errorCode))
    .map(([k]) => componentLabel(k));
  if (shaky.length > 0) {
    return { level: 'warn', text: `${joinNames(shaky)} ${shaky.length > 1 ? 'are' : 'is'} having problems — students still get answers`, notes: unverified };
  }
  return { level: 'ok', text: 'All systems normal', notes: unverified };
}

const STYLES: Record<Level, { box: string; icon: string; iconClass: string }> = {
  ok: { box: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: 'fas fa-circle-check', iconClass: 'text-emerald-500' },
  warn: { box: 'bg-amber-50 border-amber-200 text-amber-800', icon: 'fas fa-triangle-exclamation', iconClass: 'text-amber-500' },
  down: { box: 'bg-red-50 border-red-200 text-red-800', icon: 'fas fa-circle-xmark', iconClass: 'text-red-500' },
  unknown: { box: 'bg-slate-50 border-slate-200 text-slate-600', icon: 'fas fa-circle-question', iconClass: 'text-slate-400' },
};

export function StatusBanner({ health, loading }: { health: ReadinessResult | null; loading: boolean }) {
  if (loading && !health) {
    return <div className="h-14 rounded-2xl bg-slate-100 animate-pulse mb-6" />;
  }
  const { level, text, notes } = describeHealth(health);
  const s = STYLES[level];
  return (
    <div className="mb-6">
      <div role="status" className={`flex items-center gap-3 rounded-2xl border px-5 py-4 ${s.box}`}>
        <i className={`${s.icon} text-[18px] ${s.iconClass}`} />
        <p className="text-[15px] font-semibold">{text}</p>
      </div>
      {notes.map((n) => (
        <p key={n} className="text-[12px] text-slate-400 mt-1.5 ml-1">{n}</p>
      ))}
    </div>
  );
}
