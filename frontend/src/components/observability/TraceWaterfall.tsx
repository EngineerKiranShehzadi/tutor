'use client';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { SpanTreeNode, CriticalPathItem } from '@/types/observability';

const KIND_ICON: Record<string, string> = {
  LLM: 'fa-brain', RETRIEVER: 'fa-magnifying-glass', RERANKER: 'fa-sort', EMBEDDING: 'fa-vector-square',
  CHAIN: 'fa-link', AGENT: 'fa-robot', TOOL: 'fa-wrench', GUARDRAIL: 'fa-shield', EVALUATOR: 'fa-scale-balanced', PROMPT: 'fa-file-lines',
};
const KIND_COLOR: Record<string, string> = {
  LLM: '#8b5cf6', RETRIEVER: '#06b6d4', RERANKER: '#f59e0b', EMBEDDING: '#10b981',
  CHAIN: '#6366f1', AGENT: '#ec4899', TOOL: '#64748b', GUARDRAIL: '#ef4444', EVALUATOR: '#0ea5e9', PROMPT: '#64748b',
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
  const color = KIND_COLOR[node.kind] ?? '#94a3b8';
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
          'flex items-center gap-2 py-1.5 pr-4 rounded-md cursor-pointer group',
          isSelected ? 'bg-indigo-50 ring-1 ring-indigo-300' : 'hover:bg-slate-50'
        )}
        style={{ paddingLeft: 8 + node.depth * 18 }}
        title={`${node.name} — ${fmtMs(node.durationMs)}`}
      >
        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }} className="w-4 h-4 flex items-center justify-center text-slate-400 shrink-0" aria-label={collapsed ? 'Expand' : 'Collapse'}>
            <i className={`fas fa-caret-${collapsed ? 'right' : 'down'} text-[10px]`} />
          </button>
        ) : <span className="w-4 shrink-0" />}

        <button onClick={(e) => { e.stopPropagation(); onFilterKind(node.kind); }} className="shrink-0" title={`Filter Spans tab by ${node.kind}`}>
          <i className={`fas ${KIND_ICON[node.kind] ?? 'fa-circle'} text-[10px]`} style={{ color }} />
        </button>

        <span className="text-[12.5px] font-medium text-slate-700 truncate shrink-0 w-[180px]">{node.name}</span>

        <div className="flex-1 relative h-5 min-w-[120px]">
          <div className="absolute inset-y-0 left-0 right-0 bg-slate-50 rounded" />
          <div
            className={cn('absolute inset-y-0 rounded flex items-center', isError ? 'bg-red-400' : isCritical ? 'ring-2 ring-amber-400' : '')}
            style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: isError ? undefined : color, minWidth: 3 }}
          />
        </div>

        <span className="text-[11px] text-slate-400 tabular-nums w-16 text-right shrink-0">{fmtMs(node.durationMs)}</span>
        {isError && <i className="fas fa-circle-exclamation text-red-500 text-[10px] shrink-0" />}
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

  if (tree.length === 0) {
    return <p className="text-[13px] text-slate-400 py-8 text-center">This trace has no child spans (e.g. a greeting or an early-exit path).</p>;
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-3 px-2 text-[11px] text-slate-400">
        {Object.entries(KIND_COLOR).slice(0, 6).map(([kind, color]) => (
          <span key={kind} className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: color }} />{kind}</span>
        ))}
        <span className="flex items-center gap-1.5 ml-auto"><span className="w-2 h-2 rounded-sm ring-2 ring-amber-400" />Critical path</span>
      </div>
      <div className="space-y-0.5">
        {tree.map(node => (
          <WaterfallRow key={node.spanId} node={node} rootStartMs={rootStartMs} totalDurationMs={totalDurationMs} selectedSpanId={selectedSpanId} onSelect={onSelect} onFilterKind={onFilterKind} criticalPathIds={criticalPathIds} />
        ))}
      </div>
    </div>
  );
}
