/**
 * Pure scoring / sweep math for tune-thresholds.ts. No DB, no network, no clock:
 * everything here works on cached (similarity, rerank score) pairs, which is
 * what makes a 247-pair sweep free once the questions have been run once.
 *
 * The decision logic mirrors chat.service.ts exactly:
 *   1. vector search returns the top CANDIDATE_LIMIT chunks; those below
 *      VECTOR_SIMILARITY_THRESHOLD are dropped  (empty -> NO_VECTOR_CANDIDATES)
 *   2. the survivors are reranked
 *   3. dedupeAndSelect(ranked, 5, RERANK_MIN_SCORE) keeps at most 5 above the floor
 *      (empty -> ALL_CANDIDATES_BELOW_RERANK_FLOOR)
 * Step 3 is the REAL dedupeAndSelect, not a copy. One assumption: a cross-encoder
 * scores each (query, chunk) pair independently, so the score of a chunk does not
 * change when other chunks are removed from the pool — which is what lets us rerank
 * the full pool once and apply the similarity threshold afterwards.
 */
import { createHash } from 'crypto';
import { dedupeAndSelect, normalizeAnswer } from '../services/rerank.service';
import type { QnaChunk } from '../types';

export const CANDIDATE_LIMIT = 15; // chat.service.ts CANDIDATE_LIMIT
export const FINAL_TOP_N = 5;      // chat.service.ts dedupeAndSelect(rankedAll, 5)

export type QuestionKind = 'in' | 'oos-auto' | 'oos-file';

export interface CandidateScore {
  chunkId: number;
  qaId: string;
  chunkIndex: number;
  // sha1 of the normalised answer text: dedupe compares answers, and a hash keeps
  // the cache small while preserving exactly which candidates share an answer.
  answerKey: string;
  similarity: number;
  rerankScore: number;
}

export interface QuestionRecord {
  kind: QuestionKind;
  lectureId: number;           // the lecture the question is asked against
  question: string;            // the text actually embedded
  goldQaId?: string;           // in-scope only
  sourceLectureId?: number;    // oos-auto only: where the question came from
  usedParaphrase?: boolean;    // in-scope only
  candidates: CandidateScore[];
}

export type Gate = 'vector' | 'rerank';

export interface PairOutcome {
  selectedQaIds: string[];
  refusedBy: Gate | null;
}

export const answerKeyOf = (answer: string): string =>
  createHash('sha1').update(normalizeAnswer(answer)).digest('hex');

// ── grid ───────────────────────────────────────────────────────────

// Inclusive range in hundredths, so 0.1 + 0.05 style float drift never appears.
export function range(from: number, to: number, step: number): number[] {
  const n = Math.round((to - from) / step);
  return Array.from({ length: n + 1 }, (_, i) => Math.round((from + i * step) * 100) / 100);
}
export const VECTOR_GRID = range(0.2, 0.8, 0.05);   // 13 values
export const RERANK_GRID = range(0, 0.9, 0.05);     // 19 values

// ── one question, one pair ─────────────────────────────────────────

export function evaluatePair(rec: QuestionRecord, vectorThreshold: number, rerankFloor: number): PairOutcome {
  const pool = rec.candidates.filter(c => c.similarity >= vectorThreshold);
  if (pool.length === 0) return { selectedQaIds: [], refusedBy: 'vector' };

  const ranked = pool
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.rerankScore - a.c.rerankScore || a.i - b.i) // stable, like the reranker's output order
    .map(x => x.c);
  const asChunks = ranked.map(c => ({
    id: c.chunkId, answer: c.answerKey, chunk_index: c.chunkIndex, rerankScore: c.rerankScore,
  })) as unknown as QnaChunk[];
  const { selected } = dedupeAndSelect(asChunks, FINAL_TOP_N, rerankFloor);
  if (selected.length === 0) return { selectedQaIds: [], refusedBy: 'rerank' };

  const qaOf = new Map(ranked.map(c => [c.chunkId, c.qaId]));
  return { selectedQaIds: selected.map(s => qaOf.get(s.id)!), refusedBy: null };
}

// ── whole set, one pair ────────────────────────────────────────────

export interface SetCounts {
  total: number;
  accepted: number;          // something passed both gates
  refusedByVector: number;
  refusedByRerank: number;
}
export interface PairMetrics {
  vectorThreshold: number;
  rerankFloor: number;
  inScope: SetCounts & { success: number; wrongAnswer: number };      // success: gold in the final top-5
  oos: SetCounts;                                                       // oosAuto + oosFile
  oosAuto: SetCounts;
  oosFile: SetCounts;
}

const emptyCounts = (): SetCounts => ({ total: 0, accepted: 0, refusedByVector: 0, refusedByRerank: 0 });
const tally = (c: SetCounts, o: PairOutcome): void => {
  c.total++;
  if (o.refusedBy === 'vector') c.refusedByVector++;
  else if (o.refusedBy === 'rerank') c.refusedByRerank++;
  else c.accepted++;
};

export function scorePair(records: QuestionRecord[], vectorThreshold: number, rerankFloor: number): PairMetrics {
  const m: PairMetrics = {
    vectorThreshold, rerankFloor,
    inScope: { ...emptyCounts(), success: 0, wrongAnswer: 0 },
    oos: emptyCounts(), oosAuto: emptyCounts(), oosFile: emptyCounts(),
  };
  for (const rec of records) {
    const o = evaluatePair(rec, vectorThreshold, rerankFloor);
    if (rec.kind === 'in') {
      tally(m.inScope, o);
      if (o.selectedQaIds.length > 0) {
        if (rec.goldQaId !== undefined && o.selectedQaIds.includes(rec.goldQaId)) m.inScope.success++;
        else m.inScope.wrongAnswer++;
      }
    } else {
      tally(m.oos, o);
      tally(rec.kind === 'oos-auto' ? m.oosAuto : m.oosFile, o);
    }
  }
  return m;
}

export const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);
export const successRate = (m: PairMetrics): number => rate(m.inScope.success, m.inScope.total);
export const notFoundRate = (m: PairMetrics): number => rate(m.inScope.refusedByVector + m.inScope.refusedByRerank, m.inScope.total);
export const falseAcceptRate = (m: PairMetrics): number => rate(m.oos.accepted, m.oos.total);

export function sweep(records: QuestionRecord[], vGrid = VECTOR_GRID, rGrid = RERANK_GRID): PairMetrics[] {
  const out: PairMetrics[] = [];
  for (const v of vGrid) for (const r of rGrid) out.push(scorePair(records, v, r));
  return out;
}

// ── recommendation ─────────────────────────────────────────────────

const EPS = 1e-9;
export const isFeasible = (m: PairMetrics, maxFalseAccept: number): boolean => falseAcceptRate(m) <= maxFalseAccept + EPS;

// Best first: highest in-scope success; then lowest false-accept; then the higher
// (safer) floor and the higher vector threshold, because a finite out-of-scope
// sample cannot prove that a looser pair with an identical score is safe.
export function compareBest(a: PairMetrics, b: PairMetrics): number {
  return successRate(b) - successRate(a)
    || falseAcceptRate(a) - falseAcceptRate(b)
    || b.rerankFloor - a.rerankFloor
    || b.vectorThreshold - a.vectorThreshold;
}

export interface Recommendation {
  best: PairMetrics | null;        // null when no pair meets the false-accept limit
  fallback: PairMetrics | null;    // when best is null: the lowest false-accept pair
  feasibleCount: number;
  ranked: PairMetrics[];           // feasible pairs, best first
}

export function recommend(all: PairMetrics[], maxFalseAccept: number): Recommendation {
  const ranked = all.filter(m => isFeasible(m, maxFalseAccept)).sort(compareBest);
  if (ranked.length > 0) return { best: ranked[0], fallback: null, feasibleCount: ranked.length, ranked };
  const fallback = [...all].sort((a, b) => falseAcceptRate(a) - falseAcceptRate(b) || compareBest(a, b))[0] ?? null;
  return { best: null, fallback, feasibleCount: 0, ranked };
}

// Where an arbitrary pair (e.g. today's env values) sits among the feasible pairs.
export function rankOf(ranked: PairMetrics[], m: PairMetrics, maxFalseAccept: number): number | null {
  if (!isFeasible(m, maxFalseAccept)) return null;
  return 1 + ranked.filter(r => compareBest(r, m) < 0).length;
}

// ── sampling (deterministic) ───────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates on a copy; the same seed and the same input order give the same sample.
export function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const a = [...items];
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

// Independent stream per (seed, lecture, purpose) so adding a lecture never reshuffles the others.
export const subSeed = (seed: number, lectureId: number, salt: number): number =>
  (Math.imul(seed ^ 0x9E3779B9, 2654435761) ^ Math.imul(lectureId + 1, 40503) ^ Math.imul(salt + 1, 69069)) >>> 0;

// ── input parsing ──────────────────────────────────────────────────

// Paraphrase file: { "<qa_id>": "text" } or { "<lectureId>:<qa_id>": "text" } (qa_id is only unique per lecture).
export function resolveParaphrase(map: Record<string, string>, lectureId: number, qaId: string): string | null {
  const v = map[`${lectureId}:${qaId}`] ?? map[qaId];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// Rows from an .xlsx/.csv (header names case-insensitive): lecture_id, question.
export function parseOosRows(rows: Record<string, unknown>[]): { rows: { lectureId: number; question: string }[]; skipped: number } {
  const out: { lectureId: number; question: string }[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) r[k.trim().toLowerCase()] = v;
    const lectureId = Number(r['lecture_id']);
    const question = typeof r['question'] === 'string' ? r['question'].trim() : '';
    if (!Number.isInteger(lectureId) || lectureId <= 0 || question === '') { skipped++; continue; }
    out.push({ lectureId, question });
  }
  return { rows: out, skipped };
}

export const recordKey = (r: Pick<QuestionRecord, 'kind' | 'lectureId' | 'goldQaId' | 'question'>): string =>
  [r.kind, r.lectureId, r.goldQaId ?? '', createHash('sha1').update(r.question).digest('hex').slice(0, 16)].join('|');

// ── output ─────────────────────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function toCsv(all: PairMetrics[], maxFalseAccept: number): string {
  const head = [
    'vector_threshold', 'rerank_floor',
    'in_total', 'in_success_rate', 'in_not_found_rate', 'in_wrong_answer_rate', 'in_not_found_by_vector', 'in_not_found_by_rerank',
    'oos_total', 'oos_false_accept_rate', 'oos_refused_by_vector', 'oos_refused_by_rerank',
    'oos_auto_false_accept_rate', 'oos_file_total', 'oos_file_false_accept_rate', 'feasible',
  ];
  const lines = [head.join(',')];
  for (const m of all) {
    lines.push([
      m.vectorThreshold.toFixed(2), m.rerankFloor.toFixed(2),
      m.inScope.total, successRate(m).toFixed(4), notFoundRate(m).toFixed(4), rate(m.inScope.wrongAnswer, m.inScope.total).toFixed(4),
      m.inScope.refusedByVector, m.inScope.refusedByRerank,
      m.oos.total, falseAcceptRate(m).toFixed(4), m.oos.refusedByVector, m.oos.refusedByRerank,
      rate(m.oosAuto.accepted, m.oosAuto.total).toFixed(4), m.oosFile.total, rate(m.oosFile.accepted, m.oosFile.total).toFixed(4),
      isFeasible(m, maxFalseAccept) ? 1 : 0,
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

const row = (m: PairMetrics, extra = ''): string =>
  `| ${m.vectorThreshold.toFixed(2)} | ${m.rerankFloor.toFixed(2)} | ${pct(successRate(m))} | ${pct(notFoundRate(m))} | ${pct(rate(m.inScope.wrongAnswer, m.inScope.total))} `
  + `| ${pct(falseAcceptRate(m))} | ${m.oos.refusedByVector} / ${m.oos.refusedByRerank} | ${m.inScope.refusedByVector} / ${m.inScope.refusedByRerank} |${extra}`;

const TABLE_HEAD = '| vector θ | rerank floor | in-scope success | in-scope not-found | in-scope wrong | out-of-scope false-accept | OOS refused by vector / rerank | in-scope not-found by vector / rerank |';
const TABLE_RULE = '|---|---|---|---|---|---|---|---|';

export interface SummaryContext {
  database: string;
  embeddingModelVersion: string;
  rerankerModelVersion: string;
  questionMode: string;           // e.g. "exact dataset questions" | "paraphrases (38 of 40 per lecture)"
  seed: number;
  perLecture: number;
  lectures: number[];
  inScopeCount: number;
  oosAutoCount: number;
  oosFileCount: number;
  maxFalseAccept: number;
  // The pair in force today, scored exactly (it need not be on the grid).
  current: PairMetrics;
  currentOnGrid: boolean;
}

export function toMarkdown(all: PairMetrics[], ctx: SummaryContext): string {
  const rec = recommend(all, ctx.maxFalseAccept);
  const cur = ctx.current;
  const L: string[] = [];
  L.push(`# Threshold tuning — ${ctx.database}`, '');
  L.push(`- Embedding: \`${ctx.embeddingModelVersion}\` · Reranker: \`${ctx.rerankerModelVersion}\``);
  L.push(`- In-scope questions: **${ctx.inScopeCount}** over ${ctx.lectures.length} lecture(s) (${ctx.lectures.join(', ')}), up to ${ctx.perLecture} per lecture, seed ${ctx.seed}`);
  L.push(`- Question wording: **${ctx.questionMode}**${ctx.questionMode.startsWith('exact') ? ' — exact dataset questions inflate similarity; treat the in-scope numbers as an upper bound' : ''}`);
  L.push(`- Out-of-scope questions: **${ctx.oosAutoCount + ctx.oosFileCount}** (${ctx.oosAutoCount} cross-lecture, ${ctx.oosFileCount} from file)`);
  L.push(`- Constraint: out-of-scope false-accept ≤ ${pct(ctx.maxFalseAccept)} · feasible pairs: ${rec.feasibleCount} of ${all.length}`, '');

  L.push('## Recommendation', '');
  if (rec.best) {
    const b = rec.best;
    L.push(`\`VECTOR_SIMILARITY_THRESHOLD=${b.vectorThreshold.toFixed(2)}\` and \`RERANK_MIN_SCORE=${b.rerankFloor.toFixed(2)}\``, '');
    L.push(TABLE_HEAD, TABLE_RULE, row(b), '');
  } else if (rec.fallback) {
    L.push(`**No pair keeps out-of-scope false-accept ≤ ${pct(ctx.maxFalseAccept)}.** Lowest false-accept available:`, '');
    L.push(TABLE_HEAD, TABLE_RULE, row(rec.fallback), '');
  } else {
    L.push('No data.', '');
  }

  L.push('## Current values', '');
  {
    const rank = rankOf(rec.ranked, cur, ctx.maxFalseAccept);
    L.push(TABLE_HEAD, TABLE_RULE, row(cur), '');
    L.push(rank === null
      ? `The current pair (\`${cur.vectorThreshold}\` / \`${cur.rerankFloor}\`) is **not feasible**: false-accept ${pct(falseAcceptRate(cur))} > ${pct(ctx.maxFalseAccept)}.`
      : `The current pair (\`${cur.vectorThreshold}\` / \`${cur.rerankFloor}\`) is feasible and ranks **#${rank} of ${rec.feasibleCount}** feasible pairs.`);
    if (!ctx.currentOnGrid) L.push('', '(The current values are off the sweep grid; they were scored exactly.)');
    L.push('');
  }

  L.push(`## Best feasible pairs (top ${Math.min(10, rec.ranked.length)})`, '');
  if (rec.ranked.length > 0) {
    L.push(TABLE_HEAD, TABLE_RULE);
    for (const m of rec.ranked.slice(0, 10)) L.push(row(m));
    L.push('');
  } else {
    L.push('None.', '');
  }

  L.push('## Reading this', '');
  L.push('- **Refused by vector** = no candidate reached the similarity threshold (`NO_VECTOR_CANDIDATES`); **by rerank** = candidates reached the reranker but none cleared the floor (`ALL_CANDIDATES_BELOW_RERANK_FLOOR`).');
  L.push('- **In-scope wrong** = something was returned but not the gold Q&A. Success needs the gold Q&A in the final top-5 above the floor.');
  L.push('- Cross-lecture negatives come from the same course, so a question from lecture A can be legitimately answerable in lecture B: false-accept is a conservative upper bound. Add an `--oos` file of genuinely unrelated questions to tighten it.');
  L.push(`- The out-of-scope set has ${ctx.oosAutoCount + ctx.oosFileCount} questions, so false-accept moves in steps of ${ctx.oosAutoCount + ctx.oosFileCount > 0 ? pct(1 / (ctx.oosAutoCount + ctx.oosFileCount)) : 'n/a'}; ties are broken toward the safer (higher) thresholds.`);
  return L.join('\n') + '\n';
}
