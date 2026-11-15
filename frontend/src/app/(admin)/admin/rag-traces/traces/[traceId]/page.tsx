'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnPrimary, btnToolbar } from '@/components/admin/buttons';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { TraceWaterfall } from '@/components/observability/TraceWaterfall';
import { SpanDetailsPanel } from '@/components/observability/SpanDetailsPanel';
import { RetrievalInspector } from '@/components/observability/RetrievalInspector';
import { JsonViewer } from '@/components/observability/JsonViewer';
import { ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { fmtDateTime } from '@/lib/chart-format';
import { routeLabel, memoryResultLabel, notFoundReasonLabel, errorCodeLabel } from '@/lib/monitor-labels';
import { fieldLabel } from '@/lib/ui';
import type { TraceDetail } from '@/types/observability';

const TABS = ['Timeline', 'Input and output', 'Retrieval', 'Attributes', 'Events and errors', 'Notes', 'Raw data'] as const;
type Tab = typeof TABS[number];

const CARD = 'bg-[var(--card)] rounded-card border border-[var(--border)]';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

/**
 * `truncate` suits an id that is long and meaningless to read in full, such
 * as the student uuid. It is wrong for a value that is a sentence: the
 * not-found reason was being cut to "ALL_CANDIDATES_BEL...", which tells the
 * reader nothing and looks like a rendering fault. Those fields wrap instead.
 */
function SummaryField({ label, value, wrap = false }: { label: string; value: React.ReactNode; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className={fieldLabel}>{label}</dt>
      <dd className={`mt-0.5 text-label text-[var(--text)] ${wrap ? 'break-words' : 'truncate'}`}>
        {value ?? <span className="text-[var(--muted2)]">—</span>}
      </dd>
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
  const [cameFrom, setCameFrom] = useState<string | null>(null);
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

  /**
   * Preselect the step the Spans tab was pointing at.
   *
   * A row on Spans is one step, not a whole request, so it links here as
   * ?span=<spanId>. That parameter was already being sent and was never read:
   * the page opened with nothing selected and asked the reader to find, in the
   * timeline, the exact step they had just clicked on the previous page.
   *
   * Read from window.location rather than useSearchParams(), which in the App
   * Router requires a Suspense boundary around the component or `next build`
   * fails on this page. Everything here is fetched at runtime anyway, so the
   * hook buys nothing that would justify restructuring the page around it.
   *
   * Setting the id before the spans arrive is fine: selectedSpan resolves it
   * once they load, and an id that is not in this trace resolves to null and
   * leaves the panel asking for a selection, exactly as before.
   */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const span = q.get('span');
    if (span) setSelectedSpanId(span);
    setCameFrom(q.get('from'));
  }, []);

  /**
   * Where the breadcrumb goes back to.
   *
   * Four tabs link into this page and the breadcrumb was hardcoded to Traces,
   * so three of them sent the reader back to a tab they had never been on,
   * to walk across and find their place again.
   *
   * Kept separate from selectedSpanId, which changes whenever a different
   * step is clicked in the timeline. Where the reader came from is fixed when
   * the page opens; what they are looking at now is not, and tying the two
   * together would rewrite the breadcrumb under them as they explored.
   *
   * `session` carries no id: the trace already knows which session it belongs
   * to, so the id would be a second copy of a fact in the URL that could
   * disagree with the record. Before the trace loads there is nothing to read
   * it from, so the error state falls back to the Sessions list.
   */
  const parent =
    cameFrom === 'spans' ? { label: 'Spans', href: '/admin/rag-traces/spans' }
    : cameFrom === 'errors' ? { label: 'Errors', href: '/admin/rag-traces/errors' }
    : cameFrom === 'questions' ? { label: 'Questions', href: '/admin/questions' }
    : cameFrom === 'session' ? {
        label: 'Session',
        href: detail?.summary.sessionId
          ? `/admin/rag-traces/sessions/${encodeURIComponent(detail.summary.sessionId)}`
          : '/admin/rag-traces/sessions',
      }
    : { label: 'Traces', href: '/admin/rag-traces/traces' };

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
      <div className="max-w-[1180px]">
        <div className="h-28 rounded-card bg-[var(--surface)] animate-pulse mb-6" aria-hidden="true" />
        <div className="h-64 rounded-card bg-[var(--surface)] animate-pulse" aria-hidden="true" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-[1180px]">
        <AdminPageHero
          title="Trace"
          subtitle={traceId}
          parent={parent}
        />
        <div className={CARD}>
          <ErrorState message={error ?? 'Trace not found.'} onRetry={load} />
        </div>
      </div>
    );
  }

  const { summary } = detail;
  // Phoenix had no spans for this request, so the backend rebuilt the summary
  // from the request log. Everything above still holds; only the step-by-step
  // part is gone, and seven empty tabs would say that seven times over.
  const hasSpans = !!detail.rootSpan || detail.spans.length > 0;

  return (
    <div className="max-w-[1180px]">
      {/* No "Back to Traces" button: the hero's breadcrumb goes back up, and
          one page should not carry two ways to do the same thing.
          No status pill beside the title either: it shouted SUCCESS in caps
          while the Status field two lines below said "Success", which is the
          same fact twice in two different spellings. */}
      <AdminPageHero
        title={routeLabel(summary.route)}
        subtitle={`Trace ${traceId}`}
        parent={parent}
        action={
          <div className="flex items-center gap-2">
            {detail.phoenixTraceUrl && (
              <a href={detail.phoenixTraceUrl} target="_blank" rel="noopener noreferrer" className={btnToolbar}>
                <i className="fas fa-arrow-up-right-from-square mr-1.5" aria-hidden="true" /> Open in Phoenix
              </a>
            )}
            <button onClick={() => navigator.clipboard.writeText(traceId)} className={btnToolbar}>
              <i className="far fa-copy mr-1.5" aria-hidden="true" /> Copy trace ID
            </button>
          </div>
        }
      />

      <dl className={`${CARD} p-6 mb-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-x-5 gap-y-5`}>
        <SummaryField label="Status" value={<TraceStatusBadge status={summary.status} />} />
        <SummaryField label="Duration" value={fmtMs(summary.durationMs)} />
        <SummaryField label="Started" value={fmtDateTime(summary.timestamp)} />
        <SummaryField label="Route" value={routeLabel(summary.route)} />
        <SummaryField label="Lecture" value={summary.lectureId} />
        <SummaryField
          label="Session"
          value={summary.sessionId
            ? <button className="text-[var(--accent)] hover:underline" onClick={() => router.push(`/admin/rag-traces/sessions/${encodeURIComponent(summary.sessionId!)}`)}>{summary.sessionId}</button>
            : null}
        />
        <SummaryField label="Student" value={summary.userId} />
        <SummaryField label="Model" value={summary.model} />
        <SummaryField
          label="Tokens in / out"
          value={summary.totalTokens !== null ? `${summary.promptTokens ?? 0} / ${summary.completionTokens ?? 0}` : null}
        />
        <SummaryField label="Memory" value={summary.memoryResult ? memoryResultLabel(summary.memoryResult) : null} />
        <SummaryField
          label="Retrieved / used"
          value={summary.retrievalCount !== null ? `${summary.retrievalCount} / ${summary.selectedChunkCount ?? 0}` : null}
        />
        {/* Through the same label maps the rest of the admin uses, so this
            page stops being the only one showing raw constants. */}
        <SummaryField
          label="Not-found reason"
          value={summary.fallbackReason ? notFoundReasonLabel(summary.fallbackReason) : null}
          wrap
        />
        {summary.errorCode && (
          <SummaryField
            label="Error"
            value={<span className="text-[var(--gold)] font-medium">{errorCodeLabel(summary.errorCode)}</span>}
            wrap
          />
        )}
      </dl>

      {!hasSpans ? (
        <div className={`${CARD} px-8 py-12 text-center`}>
          {/* Three lines naming two storage systems, to say one thing. The
              reader does not need to know which store kept what; they need to
              know why half the page is missing and whether it is their fault. */}
          <p className="text-label font-semibold text-[var(--text)]">Step timings are no longer stored</p>
          <p className="text-caption text-[var(--muted2)] mt-1.5 max-w-md mx-auto">
            Phoenix keeps the step-by-step breakdown for a limited time, and this request is older than that.
            The details above are kept permanently, so they still show.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 border-b border-[var(--border)] mb-5 overflow-x-auto" role="tablist">
            {TABS.map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`px-4 py-3 text-label font-semibold border-b-2 whitespace-nowrap transition-colors ${
                  tab === t
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-transparent text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border)]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Timeline' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className={`lg:col-span-2 ${CARD} p-5`}>
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
                {selectedSpan ? (
                  <SpanDetailsPanel span={selectedSpan} onClose={() => setSelectedSpanId(null)} />
                ) : (
                  <div className={`${CARD} p-8 text-center`}>
                    <p className="text-caption text-[var(--muted2)]">Select a step in the timeline to inspect it.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'Input and output' && (
            <div className={`${CARD} p-6 space-y-5`}>
              {detail.rootSpan?.attributes['input.value'] ? (
                <div>
                  <p className={`${fieldLabel} mb-2`}>Original question</p>
                  <p className="text-label text-[var(--text)] bg-[var(--surface)] rounded-control p-4 whitespace-pre-wrap">{String(detail.rootSpan.attributes['input.value'])}</p>
                </div>
              ) : (
                <p className="text-caption text-[var(--muted2)]">
                  Content capture is off, so the question and answer text was never recorded. Set
                  OBSERVABILITY_CAPTURE_CONTENT to record it on future requests.
                </p>
              )}
              {detail.spans.find(s => s.name === 'rewrite-contextual-query') && (
                <div>
                  <p className={`${fieldLabel} mb-2`}>Rewritten query</p>
                  <p className="text-label text-[var(--text)] bg-[var(--surface)] rounded-control p-4">
                    {String(detail.spans.find(s => s.name === 'rewrite-contextual-query')?.attributes.rewrittenQueryPreview ?? '—')}
                  </p>
                </div>
              )}
              {/* A tab called "Input and output" that silently shows only the
                  input reads as broken. The answer is genuinely absent on the
                  not-found and error paths: those reply with a fixed template,
                  which the Status and Not-found reason fields already state,
                  so it is not recorded. Say that rather than show a gap. */}
              {/* Boolean(): attributes is Record<string, unknown>, so a bare
                  `a && b && <jsx/>` is typed unknown, which React cannot
                  render. The other blocks in this tab wrap the same way. */}
              {Boolean(detail.rootSpan?.attributes['input.value']) && !detail.rootSpan?.attributes['output.value'] && (
                <p className="text-caption text-[var(--muted2)]">
                  No answer text was recorded for this request. The question was not answered from the
                  lecture material, so the reply was a fixed message rather than a generated answer. The
                  Status and Not-found reason above say which case it was.
                </p>
              )}
              {Boolean(detail.rootSpan?.attributes['output.value']) && (
                <div>
                  <p className={`${fieldLabel} mb-2`}>Final answer</p>
                  <p className="text-label text-[var(--text)] bg-[var(--surface)] rounded-control p-4 whitespace-pre-wrap">{String(detail.rootSpan?.attributes['output.value'])}</p>
                </div>
              )}
              {/* Only model calls that have something to say. With content
                  capture off every call rendered a block holding one line,
                  "Finish reason: STOP", which is the normal ending and tells
                  the reader nothing. A call appears here when it captured
                  output, or when it stopped for a reason worth knowing, such
                  as hitting the length limit. */}
              {detail.spans
                .filter(s => s.kind === 'LLM')
                .filter(s => s.output || (s.attributes.finishReason && String(s.attributes.finishReason).toUpperCase() !== 'STOP'))
                .map(s => (
                  <div key={s.spanId} className="border-t border-[var(--border)] pt-4">
                    <p className={`${fieldLabel} mb-2`}>{s.name}, {s.model ?? 'model not recorded'}</p>
                    {s.output && <p className="text-caption text-[var(--text)] bg-[var(--surface)] rounded-control p-3 whitespace-pre-wrap">{s.output}</p>}
                    {s.attributes.finishReason && String(s.attributes.finishReason).toUpperCase() !== 'STOP' ? (
                      <p className="text-caption text-[var(--gold)] mt-1">Stopped early: {String(s.attributes.finishReason)}</p>
                    ) : null}
                  </div>
                ))}
            </div>
          )}

          {tab === 'Retrieval' && <RetrievalInspector spans={allSpans} />}

          {tab === 'Attributes' && (
            <div className={`${CARD} p-6`}>
              <JsonViewer data={detail.rootSpan?.attributes ?? {}} title="Root trace attributes" />
            </div>
          )}

          {tab === 'Events and errors' && (
            <div className={`${CARD} p-6`}>
              {allSpans.filter(s => s.status === 'ERROR' || s.events.length > 0).length === 0 ? (
                <p className="text-caption text-[var(--muted2)] text-center py-8">No errors or events were recorded on this request.</p>
              ) : (
                <div className="space-y-4">
                  {allSpans.filter(s => s.status === 'ERROR' || s.events.length > 0).map(s => (
                    <div key={s.spanId} className="border border-[var(--border)] rounded-control p-4">
                      <div className="flex items-center gap-2.5 mb-2 text-caption">
                        <TraceStatusBadge status={s.status} />
                        <span className="font-semibold text-[var(--text)]">{s.name}</span>
                      </div>
                      {s.exception && <p className="text-caption text-[var(--gold)] bg-[var(--gold-soft)] rounded-control p-3 mb-2">{s.exception.type}: {s.exception.message}</p>}
                      {s.events.map((e, i) => <p key={i} className="text-caption text-[var(--muted)]">{e.name}, {fmtDateTime(e.timestamp)}</p>)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'Notes' && (
            <div className={`${CARD} p-6`}>
              <div className="flex gap-2 mb-5">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note about this request"
                  className="flex-1 h-10 text-caption rounded-control border border-[var(--border)] px-3 focus:outline-none focus:border-[var(--accent)] placeholder:text-caption"
                  maxLength={2000}
                />
                <button onClick={submitNote} disabled={savingNote || !noteText.trim()} className={btnPrimary}>
                  {savingNote ? 'Saving' : 'Add note'}
                </button>
              </div>

              {/* The Annotations section was removed. Annotations are labels
                  or scores written by a human through the API or by an
                  automatic evaluator. Nothing in this system writes either:
                  the admin UI has no control for it and no evaluators are
                  configured, so the section could only ever read
                  "Annotations (0)". The reader is better served by one
                  section that works than by two where one never can. */}
              <p className={`${fieldLabel} mb-2`}>Notes ({detail.notes.length})</p>
              <div className="space-y-2">
                {detail.notes.length === 0 ? <p className="text-caption text-[var(--muted2)]">No notes yet.</p> : detail.notes.map(n => (
                  <div key={n.id} className="text-caption text-[var(--text)] bg-[var(--surface)] rounded-control p-3">
                    {n.note}
                    <span className="block text-caption text-[var(--muted2)] mt-1">{fmtDateTime(n.createdAt)}</span>
                  </div>
                ))}
              </div>

              {/* Said plainly, because a note is the one thing on this page a
                  person authored, and it is kept in the store with the
                  shortest memory. */}
              <p className="text-caption text-[var(--muted2)] mt-4 pt-4 border-t border-[var(--border)]">
                Notes are stored with the trace in Phoenix, so they are kept for as long as the trace is.
              </p>
            </div>
          )}

          {tab === 'Raw data' && (
            <div className={`${CARD} p-6`}>
              <JsonViewer data={detail.raw} title="Raw Phoenix trace and spans (sanitized)" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
