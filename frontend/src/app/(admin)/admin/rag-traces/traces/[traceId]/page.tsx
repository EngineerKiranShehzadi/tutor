'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { TraceWaterfall } from '@/components/observability/TraceWaterfall';
import { SpanDetailsPanel } from '@/components/observability/SpanDetailsPanel';
import { RetrievalInspector } from '@/components/observability/RetrievalInspector';
import { JsonViewer } from '@/components/observability/JsonViewer';
import { ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { TraceDetail } from '@/types/observability';

const TABS = ['Timeline', 'Input & Output', 'Retrieval', 'Attributes', 'Events & Errors', 'Annotations & Notes', 'Raw Data'] as const;
type Tab = typeof TABS[number];

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

function SummaryField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-[13px] font-semibold text-slate-800 mt-0.5 truncate">{value ?? <span className="text-slate-300 font-normal">—</span>}</p>
    </div>
  );
}

export default function TraceDetailPage({ params }: { params: { traceId: string } }) {
  const router = useRouter();
  const { traceId } = params;
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Timeline');
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await observabilityApi.getTrace(traceId);
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err instanceof ObservabilityApiError ? err.message : 'Failed to load trace.');
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  useEffect(() => { load(); }, [load]);

  const allSpans = useMemo(() => (detail ? [...(detail.rootSpan ? [detail.rootSpan] : []), ...detail.spans] : []), [detail]);
  const selectedSpan = useMemo(() => allSpans.find(s => s.spanId === selectedSpanId) ?? null, [allSpans, selectedSpanId]);

  const submitNote = async () => {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try { await observabilityApi.addTraceNote(traceId, noteText.trim()); setNoteText(''); await load(); }
    finally { setSavingNote(false); }
  };

  if (loading) {
    return (
      <div className="max-w-[1500px]">
        <div className="h-32 rounded-2xl bg-slate-100 animate-pulse mb-6" />
        <div className="h-64 rounded-2xl bg-slate-100 animate-pulse" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-[1500px]">
        <button onClick={() => router.push('/admin/rag-traces/traces')} className="text-[13px] font-semibold text-slate-500 hover:text-indigo-600 mb-4 inline-flex items-center gap-1.5">
          <i className="fas fa-arrow-left text-[11px]" /> Back to Traces
        </button>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
          <ErrorState message={error ?? 'Trace not found.'} onRetry={load} />
        </div>
      </div>
    );
  }

  const { summary } = detail;

  return (
    <div className="max-w-[1500px]">
      <button onClick={() => router.push('/admin/rag-traces/traces')} className="text-[13px] font-semibold text-slate-500 hover:text-indigo-600 mb-4 inline-flex items-center gap-1.5">
        <i className="fas fa-arrow-left text-[11px]" /> Back to Traces
      </button>

      <AdminPageHero
        icon="fas fa-diagram-project"
        iconGradient="from-purple-500 to-fuchsia-600"
        title={summary.route ?? 'Trace'}
        subtitle={`Trace ${traceId}`}
        badge={summary.status}
        action={
          <button onClick={() => navigator.clipboard.writeText(traceId)} className="text-[13px] font-semibold bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-lg px-3.5 py-2 transition-colors">
            <i className="far fa-copy mr-1.5" /> Copy trace ID
          </button>
        }
      />

      {/* Top summary */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6 grid grid-cols-6 gap-5">
        <SummaryField label="Status" value={<TraceStatusBadge status={summary.status} />} />
        <SummaryField label="Duration" value={fmtMs(summary.durationMs)} />
        <SummaryField label="Started" value={new Date(summary.timestamp).toLocaleString()} />
        <SummaryField label="Route" value={summary.route} />
        <SummaryField label="Lecture ID" value={summary.lectureId} />
        <SummaryField label="Session" value={summary.sessionId ? <button className="text-indigo-600 hover:underline" onClick={() => router.push(`/admin/rag-traces/sessions/${encodeURIComponent(summary.sessionId!)}`)}>{summary.sessionId}</button> : null} />
        <SummaryField label="User" value={summary.userId} />
        <SummaryField label="Model" value={summary.model} />
        <SummaryField label="Tokens" value={summary.totalTokens !== null ? `${summary.promptTokens ?? 0} / ${summary.completionTokens ?? 0} / ${summary.totalTokens}` : null} />
        <SummaryField label="Memory result" value={summary.memoryResult} />
        <SummaryField label="Retrieved / selected" value={summary.retrievalCount !== null ? `${summary.retrievalCount} / ${summary.selectedChunkCount ?? 0}` : null} />
        <SummaryField label="Fallback reason" value={summary.fallbackReason} />
        {summary.errorCode && <SummaryField label="Error" value={<span className="text-red-600">{summary.errorCode}</span>} />}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-5 overflow-x-auto" role="tablist">
        {TABS.map(t => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-4 py-3 text-[13px] font-semibold border-b-2 whitespace-nowrap transition-colors ${tab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Timeline' && (
        <div className="grid grid-cols-3 gap-5">
          <div className="col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <TraceWaterfall
              tree={detail.spanTree}
              rootStartTime={detail.rootSpan?.startTime ?? summary.timestamp}
              totalDurationMs={summary.durationMs}
              selectedSpanId={selectedSpanId}
              onSelect={setSelectedSpanId}
              onFilterKind={(kind) => router.push(`/admin/rag-traces/spans?spanKind=${encodeURIComponent(kind)}`)}
              criticalPath={detail.criticalPath}
            />
          </div>
          <div>
            {selectedSpan ? <SpanDetailsPanel span={selectedSpan} onClose={() => setSelectedSpanId(null)} /> : (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center text-slate-400">
                <i className="fas fa-arrow-pointer text-2xl mb-2" />
                <p className="text-[13px]">Select a span in the waterfall to inspect it.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'Input & Output' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
          {detail.rootSpan?.attributes['input.value'] ? (
            <div><p className="text-[12px] font-bold text-slate-500 uppercase tracking-wide mb-2">Original question</p><p className="text-[14px] text-slate-800 bg-slate-50 rounded-xl p-4 whitespace-pre-wrap">{String(detail.rootSpan.attributes['input.value'])}</p></div>
          ) : <p className="text-[13px] text-slate-400 italic">Content capture is off — enable OBSERVABILITY_CAPTURE_CONTENT to see question/answer text here.</p>}
          {detail.spans.find(s => s.name === 'rewrite-contextual-query') && (
            <div><p className="text-[12px] font-bold text-slate-500 uppercase tracking-wide mb-2">Rewritten query</p>
              <p className="text-[14px] text-slate-800 bg-slate-50 rounded-xl p-4">
                {String(detail.spans.find(s => s.name === 'rewrite-contextual-query')?.attributes.rewrittenQueryPreview ?? '—')}
              </p>
            </div>
          )}
          {Boolean(detail.rootSpan?.attributes['output.value']) && (
            <div><p className="text-[12px] font-bold text-slate-500 uppercase tracking-wide mb-2">Final answer</p><p className="text-[14px] text-slate-800 bg-slate-50 rounded-xl p-4 whitespace-pre-wrap">{String(detail.rootSpan?.attributes['output.value'])}</p></div>
          )}
          {detail.spans.filter(s => s.kind === 'LLM').map(s => (
            <div key={s.spanId} className="border-t border-slate-100 pt-4">
              <p className="text-[12px] font-bold text-slate-500 uppercase tracking-wide mb-2">{s.name} — {s.model ?? 'unknown model'}</p>
              {s.output && <p className="text-[13px] text-slate-700 bg-slate-50 rounded-xl p-3 whitespace-pre-wrap">{s.output}</p>}
              {s.attributes.finishReason ? <p className="text-[11px] text-slate-400 mt-1">Finish reason: {String(s.attributes.finishReason)}</p> : null}
            </div>
          ))}
        </div>
      )}

      {tab === 'Retrieval' && <RetrievalInspector spans={allSpans} />}

      {tab === 'Attributes' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <JsonViewer data={detail.rootSpan?.attributes ?? {}} title="Root trace attributes" />
        </div>
      )}

      {tab === 'Events & Errors' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          {allSpans.filter(s => s.status === 'ERROR' || s.events.length > 0).length === 0 ? (
            <p className="text-[13px] text-slate-400 text-center py-8">No errors or events recorded on this trace.</p>
          ) : (
            <div className="space-y-4">
              {allSpans.filter(s => s.status === 'ERROR' || s.events.length > 0).map(s => (
                <div key={s.spanId} className="border border-slate-100 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <TraceStatusBadge status={s.status} />
                    <span className="text-[13px] font-semibold text-slate-700">{s.name}</span>
                  </div>
                  {s.exception && <p className="text-[13px] text-red-700 bg-red-50 rounded-lg p-3 mb-2">{s.exception.type}: {s.exception.message}</p>}
                  {s.events.map((e, i) => <p key={i} className="text-[12px] text-slate-500">• {e.name} — {new Date(e.timestamp).toLocaleTimeString()}</p>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'Annotations & Notes' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <div className="flex gap-2 mb-5">
            <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note about this trace…" className="flex-1 text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-200" maxLength={2000} />
            <button onClick={submitNote} disabled={savingNote || !noteText.trim()} className="text-[13px] font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2.5 disabled:opacity-50 transition-colors">
              {savingNote ? 'Saving…' : 'Add note'}
            </button>
          </div>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">Notes ({detail.notes.length})</p>
          <div className="space-y-2 mb-5">
            {detail.notes.length === 0 ? <p className="text-[13px] text-slate-400">No notes yet.</p> : detail.notes.map(n => (
              <div key={n.id} className="text-[13px] text-slate-700 bg-slate-50 rounded-lg p-3">{n.note}<span className="block text-[11px] text-slate-400 mt-1">{new Date(n.createdAt).toLocaleString()}</span></div>
            ))}
          </div>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">Annotations ({detail.annotations.length})</p>
          <div className="space-y-2">
            {detail.annotations.length === 0 ? <p className="text-[13px] text-slate-400">No annotations yet.</p> : detail.annotations.map(a => (
              <div key={a.id} className="text-[13px] text-slate-700 bg-slate-50 rounded-lg p-3 flex items-center justify-between">
                <span>{a.name}{a.label ? `: ${a.label}` : ''}{a.score !== null ? ` (${a.score})` : ''}</span>
                <span className="text-[11px] text-slate-400">{a.annotatorKind}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'Raw Data' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <JsonViewer data={detail.raw} title="Raw Phoenix trace + spans (sanitized)" />
        </div>
      )}
    </div>
  );
}
