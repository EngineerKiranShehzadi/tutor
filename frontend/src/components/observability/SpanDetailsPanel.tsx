'use client';
import { JsonViewer } from './JsonViewer';
import { fieldLabel } from '@/lib/ui';
import { TraceStatusBadge } from './TraceStatusBadge';
import type { ObservabilitySpan } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className={`${fieldLabel} w-28 shrink-0 pt-0.5`}>{label}</span>
      <span className="text-caption text-[var(--text)] break-words">{value}</span>
    </div>
  );
}

export function SpanDetailsPanel({ span, onClose }: { span: ObservabilitySpan; onClose?: () => void }) {
  return (
    <div className="bg-[var(--card)] rounded-card border border-[var(--border)] p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-label font-semibold text-[var(--text)]">{span.name}</p>
          <p className="text-[11px] text-[var(--muted2)] font-mono mt-0.5">{span.spanId}</p>
        </div>
        <div className="flex items-center gap-2">
          <TraceStatusBadge status={span.status} />
          {onClose && <button onClick={onClose} className="text-[var(--muted2)] hover:text-[var(--muted)]"><i className="fas fa-xmark" /></button>}
        </div>
      </div>

      <div className="border-t border-[var(--border)] pt-3">
        <Field label="Kind" value={span.kind} />
        <Field label="Parent" value={span.parentId ? <span className="font-mono text-caption">{span.parentId}</span> : 'Root'} />
        <Field label="Start" value={new Date(span.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })} />
        <Field label="Duration" value={fmtMs(span.durationMs)} />
        {span.model && <Field label="Model" value={span.model} />}
        {span.provider && <Field label="Provider" value={span.provider} />}
        {span.tokens && (span.tokens.prompt !== null || span.tokens.completion !== null) && (
          <Field label="Tokens" value={`${span.tokens.prompt ?? '—'} prompt / ${span.tokens.completion ?? '—'} completion / ${span.tokens.total ?? '—'} total`} />
        )}
        {span.errorCode && <Field label="Error code" value={<span className="text-[var(--gold)] font-mono text-caption">{span.errorCode}</span>} />}
        {span.statusMessage && <Field label="Status msg" value={span.statusMessage} />}
      </div>

      {(span.input || span.output) && (
        <div className="border-t border-[var(--border)] pt-3 mt-3 space-y-3">
          {span.input && (
            <div>
              <p className={`${fieldLabel} mb-1`}>Input</p>
              <p className="text-caption text-[var(--text)] bg-[var(--surface)] rounded-control p-3 whitespace-pre-wrap break-words">{span.input}</p>
            </div>
          )}
          {span.output && (
            <div>
              <p className={`${fieldLabel} mb-1`}>Output</p>
              <p className="text-caption text-[var(--text)] bg-[var(--surface)] rounded-control p-3 whitespace-pre-wrap break-words">{span.output}</p>
            </div>
          )}
        </div>
      )}

      {span.exception && (
        <div className="border-t border-[var(--border)] pt-3 mt-3">
          <p className="text-caption font-medium text-[var(--gold)] mb-1">Exception</p>
          <p className="text-caption text-[var(--gold)] bg-[var(--gold-soft)] rounded-control p-3">{span.exception.type}: {span.exception.message}</p>
        </div>
      )}

      {span.events.length > 0 && (
        <div className="border-t border-[var(--border)] pt-3 mt-3">
          <p className={`${fieldLabel} mb-1.5`}>Events</p>
          <div className="space-y-1.5">
            {span.events.map((e, i) => (
              <div key={i} className="text-caption text-[var(--muted)] flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--border)] shrink-0" />
                <span className="font-medium">{e.name}</span>
                <span className="text-[var(--muted2)]">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[var(--border)] pt-3 mt-3">
        <p className={`${fieldLabel} mb-1.5`}>Attributes</p>
        <JsonViewer data={span.attributes} />
      </div>
    </div>
  );
}
