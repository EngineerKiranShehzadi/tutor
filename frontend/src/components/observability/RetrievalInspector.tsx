'use client';
import type { ObservabilitySpan } from '@/types/observability';

function fmtScore(s: number | null): string { return s === null ? '—' : s.toFixed(3); }

// Shows the retrieval pipeline in three stages, reading directly from the
// vector-search / rerank-candidates / generate-grounded-answer spans of a
// trace — real Phoenix-sourced data only, no synthesized ranks or scores.
export function RetrievalInspector({ spans }: { spans: ObservabilitySpan[] }) {
  const vectorSearch = spans.find(s => s.name === 'vector-search');
  const rerank = spans.find(s => s.name === 'rerank-candidates');
  const generate = spans.find(s => s.name === 'generate-grounded-answer');

  if (!vectorSearch && !rerank) {
    return <p className="text-caption text-[var(--muted2)] py-8 text-center">This trace has no retrieval step (e.g. a greeting, memory hit, or lecture summary).</p>;
  }

  const candidates = vectorSearch?.retrievalDocuments ?? [];
  const reranked = rerank?.retrievalDocuments ?? [];
  const rerankedIds = new Set(reranked.map(d => d.id));
  const threshold = vectorSearch?.attributes.similarityThreshold as number | undefined;
  const minRerankScore = rerank?.attributes.minRerankScore as number | undefined;

  return (
    <div className="grid grid-cols-3 gap-5">
      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <p className="text-label font-semibold text-[var(--text)]">Vector search candidates</p>
          <p className="text-caption text-[var(--muted2)] mt-0.5">{candidates.length} returned{threshold !== undefined ? ` · threshold ${threshold}` : ''}</p>
        </div>
        <div className="divide-y divide-[var(--border)] max-h-[420px] overflow-y-auto">
          {candidates.length === 0 ? <p className="text-caption text-[var(--muted2)] p-4">No candidates recorded.</p> : candidates.map(c => (
            <div key={c.id} className="px-5 py-2.5 flex items-center gap-2">
              <span className="text-[11px] text-[var(--muted2)] w-6 shrink-0">#{c.rank}</span>
              <span className="text-caption font-mono text-[var(--muted)] flex-1 truncate">chunk {c.id}</span>
              <span className={`text-caption font-semibold tabular-nums ${rerankedIds.has(c.id) ? 'text-[var(--accent)]' : 'text-[var(--muted2)]'}`}>{fmtScore(c.score)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <p className="text-label font-semibold text-[var(--text)]">Reranker results</p>
          <p className="text-caption text-[var(--muted2)] mt-0.5">{reranked.length} selected{minRerankScore !== undefined ? ` · floor ${minRerankScore}` : ''}</p>
        </div>
        <div className="divide-y divide-[var(--border)] max-h-[420px] overflow-y-auto">
          {reranked.length === 0 ? <p className="text-caption text-[var(--muted2)] p-4">No reranked results recorded.</p> : reranked.map(r => (
            <div key={r.id} className="px-5 py-2.5 flex items-center gap-2">
              <span className="text-[11px] text-[var(--muted2)] w-6 shrink-0">#{r.rank}</span>
              <span className="text-caption font-mono text-[var(--muted)] flex-1 truncate">chunk {r.id}</span>
              <span className="text-caption font-semibold text-[var(--accent)] tabular-nums">{fmtScore(r.score)}</span>
            </div>
          ))}
        </div>
        {rerank && (rerank.attributes.chunksRemovedByDedupe as number) > 0 && (
          <div className="px-5 py-2.5 border-t border-[var(--border)] text-[11px] text-[var(--gold)]">
            <i className="fas fa-clone mr-1.5" />{rerank.attributes.chunksRemovedByDedupe as number} duplicate chunks removed
          </div>
        )}
      </div>

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <p className="text-label font-semibold text-[var(--text)]">Final context supplied</p>
          <p className="text-caption text-[var(--muted2)] mt-0.5">{generate ? `${generate.attributes.contextChunkCount ?? reranked.length} sent to the answer model` : 'Not available'}</p>
        </div>
        <div className="p-5 space-y-2">
          {String(generate?.attributes.contextChunkIds ?? '').split(',').filter(Boolean).map((id, i) => (
            <div key={id} className="flex items-center gap-2 text-caption">
              <span className="w-5 h-5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-semibold flex items-center justify-center text-[10px] shrink-0">{i + 1}</span>
              <span className="font-mono text-[var(--muted)]">chunk {id}</span>
            </div>
          ))}
          {!generate && <p className="text-caption text-[var(--muted2)]">No answer-generation span on this trace.</p>}
        </div>
      </div>
    </div>
  );
}
