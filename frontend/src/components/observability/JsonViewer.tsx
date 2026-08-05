'use client';
import { useState } from 'react';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="text-[11px] text-slate-400 hover:text-indigo-600 transition-colors shrink-0"
      title="Copy"
      aria-label="Copy value"
    >
      <i className={copied ? 'fas fa-check text-emerald-500' : 'far fa-copy'} />
    </button>
  );
}

function Node({ label, value, depth }: { label?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null || value === undefined) {
    return <Row label={label}><span className="text-slate-400 italic">null</span></Row>;
  }
  if (typeof value === 'string') {
    return <Row label={label} raw={value}><span className="text-emerald-700">&quot;{value}&quot;</span></Row>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <Row label={label} raw={String(value)}><span className="text-indigo-600">{String(value)}</span></Row>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Row label={label}><span className="text-slate-400">[]</span></Row>;
    return (
      <div>
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left w-full hover:bg-slate-50 rounded px-1 -mx-1">
          <i className={`fas fa-caret-${open ? 'down' : 'right'} text-[10px] text-slate-400 w-3`} />
          {label && <span className="text-slate-500 font-mono text-[12px]">{label}:</span>}
          <span className="text-slate-400 text-[12px]">Array({value.length})</span>
        </button>
        {open && (
          <div className="ml-4 border-l border-slate-100 pl-3">
            {value.map((v, i) => <Node key={i} label={String(i)} value={v} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Row label={label}><span className="text-slate-400">{'{}'}</span></Row>;
    return (
      <div>
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left w-full hover:bg-slate-50 rounded px-1 -mx-1">
          <i className={`fas fa-caret-${open ? 'down' : 'right'} text-[10px] text-slate-400 w-3`} />
          {label && <span className="text-slate-500 font-mono text-[12px]">{label}:</span>}
          <span className="text-slate-400 text-[12px]">{`{${entries.length}}`}</span>
        </button>
        {open && (
          <div className="ml-4 border-l border-slate-100 pl-3">
            {entries.map(([k, v]) => <Node key={k} label={k} value={v} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }
  return <Row label={label}><span className="text-slate-400">{String(value)}</span></Row>;
}

function Row({ label, raw, children }: { label?: string; raw?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 group">
      {label && <span className="text-slate-500 font-mono text-[12px] shrink-0">{label}:</span>}
      <span className="font-mono text-[12px] truncate">{children}</span>
      {raw && <span className="opacity-0 group-hover:opacity-100 transition-opacity"><CopyButton text={raw} /></span>}
    </div>
  );
}

export function JsonViewer({ data, title }: { data: unknown; title?: string }) {
  const serialized = JSON.stringify(data, null, 2);
  return (
    <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 overflow-x-auto">
      {title && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-[12px] font-bold text-slate-500 uppercase tracking-wide">{title}</p>
          <CopyButton text={serialized} />
        </div>
      )}
      <Node value={data} depth={0} />
    </div>
  );
}
