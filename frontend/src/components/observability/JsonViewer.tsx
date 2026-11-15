'use client';
import { useState } from 'react';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="text-[11px] text-[var(--muted2)] hover:text-[var(--accent-deep)] transition-colors shrink-0"
      title="Copy"
      aria-label="Copy value"
    >
      <i className={copied ? 'fas fa-check text-[var(--accent)]' : 'far fa-copy'} />
    </button>
  );
}

function Node({ label, value, depth }: { label?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null || value === undefined) {
    return <Row label={label}><span className="text-[var(--muted2)] italic">null</span></Row>;
  }
  if (typeof value === 'string') {
    return <Row label={label} raw={value}><span className="text-[var(--accent)]">&quot;{value}&quot;</span></Row>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <Row label={label} raw={String(value)}><span className="text-[var(--accent)]">{String(value)}</span></Row>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Row label={label}><span className="text-[var(--muted2)]">[]</span></Row>;
    return (
      <div>
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left w-full hover:bg-[var(--surface)] rounded px-1 -mx-1">
          <i className={`fas fa-caret-${open ? 'down' : 'right'} text-[10px] text-[var(--muted2)] w-3`} />
          {label && <span className="text-[var(--muted)] font-mono text-caption">{label}:</span>}
          <span className="text-[var(--muted2)] text-caption">Array({value.length})</span>
        </button>
        {open && (
          <div className="ml-4 border-l border-[var(--border)] pl-3">
            {value.map((v, i) => <Node key={i} label={String(i)} value={v} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Row label={label}><span className="text-[var(--muted2)]">{'{}'}</span></Row>;
    return (
      <div>
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left w-full hover:bg-[var(--surface)] rounded px-1 -mx-1">
          <i className={`fas fa-caret-${open ? 'down' : 'right'} text-[10px] text-[var(--muted2)] w-3`} />
          {label && <span className="text-[var(--muted)] font-mono text-caption">{label}:</span>}
          <span className="text-[var(--muted2)] text-caption">{`{${entries.length}}`}</span>
        </button>
        {open && (
          <div className="ml-4 border-l border-[var(--border)] pl-3">
            {entries.map(([k, v]) => <Node key={k} label={k} value={v} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }
  return <Row label={label}><span className="text-[var(--muted2)]">{String(value)}</span></Row>;
}

function Row({ label, raw, children }: { label?: string; raw?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 group">
      {label && <span className="text-[var(--muted)] font-mono text-caption shrink-0">{label}:</span>}
      <span className="font-mono text-caption truncate">{children}</span>
      {raw && <span className="opacity-0 group-hover:opacity-100 transition-opacity"><CopyButton text={raw} /></span>}
    </div>
  );
}

export function JsonViewer({ data, title }: { data: unknown; title?: string }) {
  const serialized = JSON.stringify(data, null, 2);
  return (
    <div className="bg-[var(--surface)] rounded-card border border-[var(--border)] p-4 overflow-x-auto">
      {title && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-caption font-semibold text-[var(--muted)]">{title}</p>
          <CopyButton text={serialized} />
        </div>
      )}
      <Node value={data} depth={0} />
    </div>
  );
}
