'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { SessionDetail } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

export default function SessionDetailPage({ params }: { params: { sessionId: string } }) {
  const router = useRouter();
  const { sessionId } = params;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setDetail(await observabilityApi.getSession(sessionId)); setError(null); }
    catch (err) { setError(err instanceof ObservabilityApiError ? err.message : 'Failed to load session.'); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="max-w-[1500px]"><div className="h-32 rounded-2xl bg-slate-100 animate-pulse mb-6" /><div className="h-64 rounded-2xl bg-slate-100 animate-pulse" /></div>;

  if (error || !detail) {
    return (
      <div className="max-w-[1500px]">
        <button onClick={() => router.push('/admin/rag-traces/sessions')} className="text-[13px] font-semibold text-slate-500 hover:text-indigo-600 mb-4 inline-flex items-center gap-1.5"><i className="fas fa-arrow-left text-[11px]" /> Back to Sessions</button>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm"><ErrorState message={error ?? 'Session not found.'} onRetry={load} /></div>
      </div>
    );
  }

  const { summary, turns } = detail;

  return (
    <div className="max-w-[1500px]">
      <button onClick={() => router.push('/admin/rag-traces/sessions')} className="text-[13px] font-semibold text-slate-500 hover:text-indigo-600 mb-4 inline-flex items-center gap-1.5"><i className="fas fa-arrow-left text-[11px]" /> Back to Sessions</button>

      <AdminPageHero icon="fas fa-comments" iconGradient="from-purple-500 to-fuchsia-600" title="Session" subtitle={sessionId} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6 grid grid-cols-6 gap-5">
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Traces</p><p className="text-[20px] font-extrabold text-slate-900">{summary.traceCount}</p></div>
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Total duration</p><p className="text-[20px] font-extrabold text-slate-900">{fmtMs(summary.totalDurationMs)}</p></div>
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Total tokens</p><p className="text-[20px] font-extrabold text-slate-900">{summary.totalTokens ?? '—'}</p></div>
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Success</p><p className="text-[20px] font-extrabold text-emerald-600">{summary.successCount ?? '—'}</p></div>
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Errors</p><p className="text-[20px] font-extrabold text-red-600">{summary.errorCount ?? '—'}</p></div>
        <div><p className="text-[11px] font-semibold text-slate-400 uppercase">Routes</p><p className="text-[13px] font-semibold text-slate-700 mt-1">{summary.routes?.join(', ') || '—'}</p></div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div className="px-6 pt-5 pb-3"><h2 className="text-[15px] font-bold text-slate-900">Conversation turns</h2><p className="text-[12px] text-slate-400 mt-0.5">Ordered by trace start time — click a turn to open its trace</p></div>
        <div className="divide-y divide-slate-100">
          {turns.length === 0 ? <p className="text-[13px] text-slate-400 px-6 pb-6">No turns recorded.</p> : turns.map((t, i) => (
            <button key={t.traceId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}`)} className="w-full text-left px-6 py-4 hover:bg-slate-50/60 transition-colors flex items-start gap-4">
              <span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center text-[11px] shrink-0 mt-0.5">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <TraceStatusBadge status={t.status} />
                  <span className="text-[12px] font-medium text-slate-500">{t.route ?? '—'}</span>
                  <span className="text-[12px] text-slate-400 ml-auto">{fmtMs(t.durationMs)}</span>
                </div>
                {t.input && <p className="text-[13px] text-slate-700 truncate"><span className="font-semibold">Q:</span> {t.input}</p>}
                {t.output && <p className="text-[13px] text-slate-500 truncate mt-0.5"><span className="font-semibold">A:</span> {t.output}</p>}
                {!t.input && !t.output && <p className="text-[12px] text-slate-300 italic">Content capture is off</p>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
