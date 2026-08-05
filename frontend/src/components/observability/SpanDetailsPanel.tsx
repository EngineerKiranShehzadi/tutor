'use client';
import { JsonViewer } from './JsonViewer';
import { TraceStatusBadge } from './TraceStatusBadge';
import type { ObservabilitySpan } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-[13px] text-slate-700 break-words">{value}</span>
    </div>
  );
}

export function SpanDetailsPanel({ span, onClose }: { span: ObservabilitySpan; onClose?: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[15px] font-bold text-slate-900">{span.name}</p>
          <p className="text-[11px] text-slate-400 font-mono mt-0.5">{span.spanId}</p>
        </div>
        <div className="flex items-center gap-2">
          <TraceStatusBadge status={span.status} />
          {onClose && <button onClick={onClose} className="text-slate-300 hover:text-slate-600"><i className="fas fa-xmark" /></button>}
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3">
        <Field label="Kind" value={span.kind} />
        <Field label="Parent" value={span.parentId ? <span className="font-mono text-[12px]">{span.parentId}</span> : 'Root'} />
        <Field label="Start" value={new Date(span.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })} />
        <Field label="Duration" value={fmtMs(span.durationMs)} />
        {span.model && <Field label="Model" value={span.model} />}
        {span.provider && <Field label="Provider" value={span.provider} />}
        {span.tokens && (span.tokens.prompt !== null || span.tokens.completion !== null) && (
          <Field label="Tokens" value={`${span.tokens.prompt ?? '—'} prompt / ${span.tokens.completion ?? '—'} completion / ${span.tokens.total ?? '—'} total`} />
        )}
        {span.errorCode && <Field label="Error code" value={<span className="text-red-600 font-mono text-[12px]">{span.errorCode}</span>} />}
        {span.statusMessage && <Field label="Status msg" value={span.statusMessage} />}
      </div>

      {(span.input || span.output) && (
        <div className="border-t border-slate-100 pt-3 mt-3 space-y-3">
          {span.input && (
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Input</p>
              <p className="text-[13px] text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap break-words">{span.input}</p>
            </div>
          )}
          {span.output && (
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Output</p>
              <p className="text-[13px] text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap break-words">{span.output}</p>
            </div>
          )}
        </div>
      )}

      {span.exception && (
        <div className="border-t border-slate-100 pt-3 mt-3">
          <p className="text-[11px] font-semibold text-red-500 uppercase tracking-wide mb-1">Exception</p>
          <p className="text-[13px] text-red-700 bg-red-50 rounded-lg p-3">{span.exception.type}: {span.exception.message}</p>
        </div>
      )}

      {span.events.length > 0 && (
        <div className="border-t border-slate-100 pt-3 mt-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Events</p>
          <div className="space-y-1.5">
            {span.events.map((e, i) => (
              <div key={i} className="text-[12px] text-slate-600 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                <span className="font-medium">{e.name}</span>
                <span className="text-slate-400">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-slate-100 pt-3 mt-3">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Attributes</p>
        <JsonViewer data={span.attributes} />
      </div>
    </div>
  );
}
