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
    return <p className="text-[13px] text-slate-400 py-8 text-center">This trace has no retrieval step (e.g. a greeting, memory hit, or lecture summary).</p>;
  }

  const candidates = vectorSearch?.retrievalDocuments ?? [];
  const reranked = rerank?.retrievalDocuments ?? [];
  const rerankedIds = new Set(reranked.map(d => d.id));
  const threshold = vectorSearch?.attributes.similarityThreshold as number | undefined;
  const minRerankScore = rerank?.attributes.minRerankScore as number | undefined;

  return (
    <div className="grid grid-cols-3 gap-5">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <p className="text-[13px] font-bold text-slate-900">Vector search candidates</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{candidates.length} returned{threshold !== undefined ? ` · threshold ${threshold}` : ''}</p>
        </div>
        <div className="divide-y divide-slate-50 max-h-[420px] overflow-y-auto">
          {candidates.length === 0 ? <p className="text-[12px] text-slate-400 p-4">No candidates recorded.</p> : candidates.map(c => (
            <div key={c.id} className="px-5 py-2.5 flex items-center gap-2">
              <span className="text-[11px] text-slate-400 w-6 shrink-0">#{c.rank}</span>
              <span className="text-[12px] font-mono text-slate-600 flex-1 truncate">chunk {c.id}</span>
              <span className={`text-[12px] font-bold tabular-nums ${rerankedIds.has(c.id) ? 'text-emerald-600' : 'text-slate-400'}`}>{fmtScore(c.score)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <p className="text-[13px] font-bold text-slate-900">Reranker results</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{reranked.length} selected{minRerankScore !== undefined ? ` · floor ${minRerankScore}` : ''}</p>
        </div>
        <div className="divide-y divide-slate-50 max-h-[420px] overflow-y-auto">
          {reranked.length === 0 ? <p className="text-[12px] text-slate-400 p-4">No reranked results recorded.</p> : reranked.map(r => (
            <div key={r.id} className="px-5 py-2.5 flex items-center gap-2">
              <span className="text-[11px] text-slate-400 w-6 shrink-0">#{r.rank}</span>
              <span className="text-[12px] font-mono text-slate-600 flex-1 truncate">chunk {r.id}</span>
              <span className="text-[12px] font-bold text-emerald-600 tabular-nums">{fmtScore(r.score)}</span>
            </div>
          ))}
        </div>
        {rerank && (rerank.attributes.chunksRemovedByDedupe as number) > 0 && (
          <div className="px-5 py-2.5 border-t border-slate-100 text-[11px] text-amber-600">
            <i className="fas fa-clone mr-1.5" />{rerank.attributes.chunksRemovedByDedupe as number} duplicate-answer chunk(s) removed
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <p className="text-[13px] font-bold text-slate-900">Final context supplied</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{generate ? `${generate.attributes.contextChunkCount ?? reranked.length} chunk(s) sent to Gemini` : 'Not available'}</p>
        </div>
        <div className="p-5 space-y-2">
          {String(generate?.attributes.contextChunkIds ?? '').split(',').filter(Boolean).map((id, i) => (
            <div key={id} className="flex items-center gap-2 text-[12px]">
              <span className="w-5 h-5 rounded-full bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center text-[10px] shrink-0">{i + 1}</span>
              <span className="font-mono text-slate-600">chunk {id}</span>
            </div>
          ))}
          {!generate && <p className="text-[12px] text-slate-400">No answer-generation span on this trace.</p>}
        </div>
      </div>
    </div>
  );
}
