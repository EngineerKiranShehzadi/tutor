'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { observabilityApi } from '@/lib/api';

interface RagTraceSummary {
  traceId: string;
  spanId: string;
  name: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

interface RagTraceSpan {
  spanId: string;
  parentId: string | null;
  name: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

function StatusBadge({ status }: { status: string }) {
  const isError = status === 'ERROR';
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1 rounded-full border ${
      isError
        ? 'text-red-700 bg-red-50 border-red-200'
        : 'text-emerald-700 bg-emerald-50 border-emerald-200'
    }`}>
      <i className={`fas ${isError ? 'fa-circle-exclamation' : 'fa-circle-check'} text-[10px]`} />
      {status}
    </span>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export default function AdminRagTracesPage() {
  const [traces, setTraces]   = useState<RagTraceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [spans, setSpans]     = useState<RagTraceSpan[]>([]);
  const [spansLoading, setSpansLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await observabilityApi.listRagTraces(50);
      setTraces(data.traces);
      setError(null);
    } catch {
      setError('Unable to reach Phoenix. Make sure it is running and OBSERVABILITY_ENABLED / PHOENIX_ENABLED are set in the backend .env.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const toggleExpand = async (traceId: string) => {
    if (expanded === traceId) { setExpanded(null); return; }
    setExpanded(traceId);
    setSpansLoading(true);
    try {
      const { data } = await observabilityApi.getRagTraceSpans(traceId);
      setSpans(data.spans);
    } catch {
      setSpans([]);
    } finally {
      setSpansLoading(false);
    }
  };

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-timeline"
        iconGradient="from-purple-500 to-fuchsia-600"
        title="RAG Traces"
        subtitle={loading ? 'Loading…' : `${traces.length} recent request${traces.length !== 1 ? 's' : ''} traced`}
      />

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="h-4 w-40 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-16 bg-slate-100 rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-plug-circle-xmark text-3xl mb-3 text-red-400" />
          <p className="text-[17px] font-semibold text-slate-600">Phoenix unreachable</p>
          <p className="text-[14px] mt-1 max-w-md text-center">{error}</p>
        </div>
      ) : traces.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-timeline text-3xl mb-3" />
          <p className="text-[17px] font-semibold text-slate-600">No traces yet</p>
          <p className="text-[14px] mt-1">Ask the tutor a question to generate one.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Time</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Route</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Status</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Duration</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Trace ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {traces.map(t => (
                <Fragment key={t.traceId}>
                  <tr
                    onClick={() => toggleExpand(t.traceId)}
                    className="hover:bg-slate-50/60 transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-4 text-[13px] text-slate-500 whitespace-nowrap">
                      {new Date(t.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="px-4 py-4 text-[14px] font-medium text-slate-700">
                      {String(t.attributes.route ?? t.name)}
                    </td>
                    <td className="px-4 py-4"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-4 text-[13px] text-slate-500 tabular-nums">{formatMs(t.durationMs)}</td>
                    <td className="px-4 py-4 text-[12px] text-slate-400 font-mono truncate max-w-[220px]">{t.traceId}</td>
                  </tr>
                  {expanded === t.traceId && (
                    <tr>
                      <td colSpan={5} className="bg-slate-50/70 px-6 py-4">
                        {spansLoading ? (
                          <div className="h-4 w-32 bg-slate-100 rounded animate-pulse" />
                        ) : spans.length === 0 ? (
                          <p className="text-[13px] text-slate-400">No spans found for this trace.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {spans.map(s => (
                              <div key={s.spanId} className="flex items-center gap-3 text-[13px]" style={{ paddingLeft: s.parentId ? 20 : 0 }}>
                                <span className="text-slate-600 font-medium min-w-[220px] truncate">{s.name}</span>
                                <StatusBadge status={s.status} />
                                <span className="text-slate-400 tabular-nums">{formatMs(s.durationMs)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
