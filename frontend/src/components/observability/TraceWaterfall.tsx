'use client';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { SpanTreeNode, CriticalPathItem } from '@/types/observability';

const KIND_ICON: Record<string, string> = {
  LLM: 'fa-brain', RETRIEVER: 'fa-magnifying-glass', RERANKER: 'fa-sort', EMBEDDING: 'fa-vector-square',
  CHAIN: 'fa-link', AGENT: 'fa-robot', TOOL: 'fa-wrench', GUARDRAIL: 'fa-shield', EVALUATOR: 'fa-scale-balanced', PROMPT: 'fa-file-lines',
};
// Every kind needs its own colour. CHAIN and EMBEDDING were both #1f3a5f,
// and RETRIEVER and AGENT were both #4a6b8a, so on a trace holding both of a
// pair the legend pointed two names at one colour.
const KIND_COLOR: Record<string, string> = {
  CHAIN: '#1f3a5f', LLM: '#8fb0d0', RETRIEVER: '#4a6b8a', EMBEDDING: '#a8bcd0',
  RERANKER: '#a35f0d', AGENT: '#16293f', TOOL: '#8e8e92', GUARDRAIL: '#c9a227',
  EVALUATOR: '#6b8fb0', PROMPT: '#b9bcc2',
};

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

interface RowProps {
  node: SpanTreeNode;
  rootStartMs: number;
  totalDurationMs: number;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
  onFilterKind: (kind: string) => void;
  criticalPathIds: Set<string>;
}

function WaterfallRow({ node, rootStartMs, totalDurationMs, selectedSpanId, onSelect, onFilterKind, criticalPathIds }: RowProps) {
  const [collapsed, setCollapsed] = useState(false);
  const offsetMs = Math.max(0, new Date(node.startTime).getTime() - rootStartMs);
  const leftPct = totalDurationMs > 0 ? (offsetMs / totalDurationMs) * 100 : 0;
  const widthPct = totalDurationMs > 0 ? Math.max(0.4, (node.durationMs / totalDurationMs) * 100) : 0;
  const color = KIND_COLOR[node.kind] ?? '#8e8e92';
  const isSelected = selectedSpanId === node.spanId;
  const isCritical = criticalPathIds.has(node.spanId);
  const isError = node.status === 'ERROR';

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.spanId)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(node.spanId); }}
        className={cn(
          // The critical path is the chain of steps that set the total time.
          // The backend works it out and passes it in, the legend announced
          // it, and nothing drew it: the row's only marker was the class
          // string ' ', a single space. It is a bar in the left gutter now.
          'flex items-center gap-2 py-1.5 pr-4 rounded-control cursor-pointer group border-l-2',
          isCritical ? 'border-[var(--accent)]' : 'border-transparent',
          isSelected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface)]'
        )}
        style={{ paddingLeft: 6 + node.depth * 18 }}
        title={`${node.name}, ${fmtMs(node.durationMs)}${isCritical ? ', on the critical path' : ''}`}
      >
        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }} className="w-4 h-4 flex items-center justify-center text-[var(--muted2)] shrink-0" aria-label={collapsed ? 'Expand' : 'Collapse'}>
            <i className={`fas fa-caret-${collapsed ? 'right' : 'down'} text-[10px]`} />
          </button>
        ) : <span className="w-4 shrink-0" />}

        <button onClick={(e) => { e.stopPropagation(); onFilterKind(node.kind); }} className="shrink-0" title={`Filter Spans tab by ${node.kind}`}>
          <i className={`fas ${KIND_ICON[node.kind] ?? 'fa-circle'} text-[10px]`} style={{ color }} />
        </button>

        <span className="text-[12.5px] font-medium text-[var(--text)] truncate shrink-0 w-[180px]">{node.name}</span>

        <div className="flex-1 relative h-5 min-w-[120px]">
          <div className="absolute inset-y-0 left-0 right-0 bg-[var(--surface)] rounded" />
          <div
            className={cn('absolute inset-y-0 rounded', isError && 'bg-[var(--gold)]')}
            style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: isError ? undefined : color, minWidth: 3 }}
          />
        </div>

        <span className="text-[11px] text-[var(--muted2)] tabular-nums w-16 text-right shrink-0">{fmtMs(node.durationMs)}</span>
        {isError && <i className="fas fa-circle-exclamation text-[var(--gold)] text-[10px] shrink-0" />}
      </div>
      {!collapsed && node.children.map(child => (
        <WaterfallRow key={child.spanId} node={child} rootStartMs={rootStartMs} totalDurationMs={totalDurationMs} selectedSpanId={selectedSpanId} onSelect={onSelect} onFilterKind={onFilterKind} criticalPathIds={criticalPathIds} />
      ))}
    </>
  );
}

interface TraceWaterfallProps {
  tree: SpanTreeNode[];
  rootStartTime: string;
  totalDurationMs: number;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
  onFilterKind: (kind: string) => void;
  criticalPath: CriticalPathItem[];
}

export function TraceWaterfall({ tree, rootStartTime, totalDurationMs, selectedSpanId, onSelect, onFilterKind, criticalPath }: TraceWaterfallProps) {
  const rootStartMs = new Date(rootStartTime).getTime();
  const criticalPathIds = new Set(criticalPath.map(c => c.spanId));

  // Only the kinds this trace actually contains. The legend printed the first
  // six entries of KIND_COLOR every time, so a greeting made of CHAIN and LLM
  // spans still advertised RETRIEVER, RERANKER, EMBEDDING and AGENT, naming
  // four colours that appear nowhere on the chart.
  const kindsPresent: string[] = [];
  const walk = (nodes: SpanTreeNode[]) => nodes.forEach(n => {
    if (!kindsPresent.includes(n.kind)) kindsPresent.push(n.kind);
    walk(n.children);
  });
  walk(tree);
  kindsPresent.sort((a, b) => Object.keys(KIND_COLOR).indexOf(a) - Object.keys(KIND_COLOR).indexOf(b));

  if (tree.length === 0) {
    return <p className="text-caption text-[var(--muted2)] py-8 text-center">This trace has no child spans (e.g. a greeting or an early-exit path).</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 px-2 text-[11px] text-[var(--muted2)]">
        {kindsPresent.map(kind => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-control" style={{ background: KIND_COLOR[kind] ?? '#8e8e92' }} />{kind}
          </span>
        ))}
        {/* Shown only when there is a critical path to point at, and with a
            swatch that matches what the rows now draw. It used to be an empty
            span with no background: a legend entry for an invisible colour. */}
        {criticalPathIds.size > 0 && (
          <span className="flex items-center gap-1.5 ml-auto" title="The chain of steps that set the total time">
            <span className="w-0.5 h-3 bg-[var(--accent)]" />Critical path
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {tree.map(node => (
          <WaterfallRow key={node.spanId} node={node} rootStartMs={rootStartMs} totalDurationMs={totalDurationMs} selectedSpanId={selectedSpanId} onSelect={onSelect} onFilterKind={onFilterKind} criticalPathIds={criticalPathIds} />
        ))}
      </div>
    </div>
  );
}
