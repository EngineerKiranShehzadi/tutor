/**
 * Scoring / sweep math of the threshold tuner (tune-thresholds-lib.ts).
 * Synthetic scores only: no database, no network, no providers called.
 *
 * Usage: npm run test:tune-thresholds
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  RERANK_GRID, VECTOR_GRID, answerKeyOf, compareBest, evaluatePair, falseAcceptRate, isFeasible, mulberry32, parseOosRows,
  range, rankOf, recommend, recordKey, resolveParaphrase, sample, scorePair, subSeed, successRate, sweep, toCsv, toMarkdown,
  type CandidateScore, type PairMetrics, type QuestionRecord, type SummaryContext,
} from './tune-thresholds-lib';

interface Case { label: string; run: () => boolean }
const cases: Case[] = [];

let nextChunk = 1;
// A candidate: [qaId, similarity, rerankScore, answer?, chunkIndex?]
const cand = (qaId: string, similarity: number, rerankScore: number, answer = `answer of ${qaId}`, chunkIndex = 0): CandidateScore =>
  ({ chunkId: nextChunk++, qaId, chunkIndex, answerKey: answerKeyOf(answer), similarity, rerankScore });
const rec = (kind: QuestionRecord['kind'], candidates: CandidateScore[], goldQaId?: string): QuestionRecord =>
  ({ kind, lectureId: 1, question: `q${nextChunk}`, goldQaId, candidates });

// ── grid ──
cases.push({ label: 'grids are exact: vector 0.20..0.80 (13), rerank 0.00..0.90 (19), no float drift', run: () =>
  VECTOR_GRID.length === 13 && RERANK_GRID.length === 19 && VECTOR_GRID[0] === 0.2 && VECTOR_GRID[12] === 0.8
  && RERANK_GRID[0] === 0 && RERANK_GRID[18] === 0.9 && VECTOR_GRID.includes(0.55) && RERANK_GRID.includes(0.5)
  && VECTOR_GRID.includes(0.35) && RERANK_GRID.includes(0.35) && JSON.stringify(range(0.1, 0.3, 0.05)) === '[0.1,0.15,0.2,0.25,0.3]' });

// ── evaluatePair: the two gates ──
cases.push({ label: 'vector gate: nothing at/above the similarity threshold → refused by vector; threshold itself passes', run: () => {
  const r = rec('in', [cand('A', 0.5, 0.9), cand('B', 0.4, 0.8)], 'A');
  return evaluatePair(r, 0.6, 0).refusedBy === 'vector' && evaluatePair(r, 0.5, 0).refusedBy === null;
} });
cases.push({ label: 'rerank gate: candidates pass similarity but none clears the floor → refused by rerank; score == floor passes', run: () => {
  const r = rec('in', [cand('A', 0.9, 0.4), cand('B', 0.8, 0.3)], 'A');
  return evaluatePair(r, 0.5, 0.5).refusedBy === 'rerank' && evaluatePair(r, 0.5, 0.4).selectedQaIds.join() === 'A';
} });
cases.push({ label: 'candidates are ordered by rerank score, not by similarity', run: () => {
  const r = rec('in', [cand('A', 0.9, 0.3), cand('B', 0.8, 0.9), cand('C', 0.7, 0.6)], 'B');
  return evaluatePair(r, 0.5, 0).selectedQaIds.join() === 'B,C,A';
} });
cases.push({ label: 'final context is at most 5: a gold ranked 6th by the reranker is a miss', run: () => {
  const cs = ['a', 'b', 'c', 'd', 'e', 'GOLD'].map((q, i) => cand(q, 0.9, 0.9 - i * 0.05));
  const m = scorePair([rec('in', cs, 'GOLD')], 0.5, 0);
  return evaluatePair(rec('in', cs, 'GOLD'), 0.5, 0).selectedQaIds.length === 5 && m.inScope.success === 0 && m.inScope.wrongAnswer === 1;
} });
cases.push({ label: 'dedupe uses the real rule: same answer + same chunk index collapses, the freed slot is backfilled', run: () => {
  const cs = [cand('A', 0.9, 0.9, 'same'), cand('B', 0.9, 0.8, 'same'), cand('C', 0.9, 0.7, 'other')];
  return evaluatePair(rec('in', cs, 'C'), 0.5, 0).selectedQaIds.join() === 'A,C';
} });
cases.push({ label: 'a long answer split in pieces (same answer, different chunk index) is NOT collapsed', run: () => {
  const cs = [cand('A', 0.9, 0.9, 'long', 0), cand('A', 0.9, 0.8, 'long', 1)];
  return evaluatePair(rec('in', cs, 'A'), 0.5, 0).selectedQaIds.length === 2;
} });
cases.push({ label: 'a lowered similarity threshold changes the pool, not the scores of what remains', run: () => {
  const cs = [cand('A', 0.7, 0.9), cand('B', 0.3, 0.95)];
  return evaluatePair(rec('in', cs, 'A'), 0.2, 0).selectedQaIds.join() === 'B,A' && evaluatePair(rec('in', cs, 'A'), 0.5, 0).selectedQaIds.join() === 'A';
} });
cases.push({ label: 'empty candidate list (no embedded chunks) → refused by vector', run: () =>
  evaluatePair(rec('oos-auto', []), 0.2, 0).refusedBy === 'vector' });

// ── scorePair: counts and rates ──
const fixture = (): QuestionRecord[] => [
  rec('in', [cand('G1', 0.8, 0.9)], 'G1'),                       // hit
  rec('in', [cand('X', 0.8, 0.9)], 'G2'),                        // wrong answer
  rec('in', [cand('G3', 0.4, 0.9)], 'G3'),                       // refused by vector at 0.5
  rec('in', [cand('G4', 0.8, 0.2)], 'G4'),                       // refused by rerank at 0.5
  rec('oos-auto', [cand('Y', 0.8, 0.9)]),                        // false accept
  rec('oos-auto', [cand('Y', 0.4, 0.9)]),                        // refused by vector
  rec('oos-file', [cand('Y', 0.8, 0.1)]),                        // refused by rerank
  rec('oos-file', [cand('Y', 0.9, 0.95)]),                       // false accept
];
cases.push({ label: 'scorePair: success / wrong / not-found split by gate, false-accept over both OOS sources', run: () => {
  const m = scorePair(fixture(), 0.5, 0.5);
  return m.inScope.total === 4 && m.inScope.success === 1 && m.inScope.wrongAnswer === 1
    && m.inScope.refusedByVector === 1 && m.inScope.refusedByRerank === 1
    && m.oos.total === 4 && m.oos.accepted === 2 && m.oos.refusedByVector === 1 && m.oos.refusedByRerank === 1
    && m.oosAuto.total === 2 && m.oosAuto.accepted === 1 && m.oosFile.total === 2 && m.oosFile.accepted === 1
    && successRate(m) === 0.25 && falseAcceptRate(m) === 0.5;
} });
cases.push({ label: 'rates of an empty set are 0, not NaN', run: () => {
  const m = scorePair([], 0.5, 0.5);
  return successRate(m) === 0 && falseAcceptRate(m) === 0;
} });

// ── sweep properties ──
const randomRecords = (): QuestionRecord[] => {
  const rnd = mulberry32(7);
  return Array.from({ length: 60 }, (_, i) => {
    const kind: QuestionRecord['kind'] = i % 3 === 0 ? 'oos-auto' : 'in';
    const cs = Array.from({ length: 8 }, (_, j) => cand(`Q${i}_${j}`, rnd(), rnd()));
    return rec(kind, cs, kind === 'in' ? `Q${i}_0` : undefined);
  });
};
cases.push({ label: 'sweep covers the full 13 x 19 grid, each pair scored once', run: () => {
  const g = sweep(randomRecords());
  return g.length === 13 * 19 && new Set(g.map(m => `${m.vectorThreshold}/${m.rerankFloor}`)).size === 247;
} });
cases.push({ label: 'monotone: raising either threshold never increases acceptance (false-accept or in-scope accepted)', run: () => {
  const recs = randomRecords();
  const g = new Map(sweep(recs).map(m => [`${m.vectorThreshold}/${m.rerankFloor}`, m]));
  for (const v of VECTOR_GRID) for (const r of RERANK_GRID) {
    const here = g.get(`${v}/${r}`)!;
    const vi = VECTOR_GRID.indexOf(v), ri = RERANK_GRID.indexOf(r);
    const nexts = [vi + 1 < VECTOR_GRID.length ? g.get(`${VECTOR_GRID[vi + 1]}/${r}`) : null, ri + 1 < RERANK_GRID.length ? g.get(`${v}/${RERANK_GRID[ri + 1]}`) : null];
    for (const n of nexts) if (n && (n.oos.accepted > here.oos.accepted || n.inScope.accepted > here.inScope.accepted)) return false;
  }
  return true;
} });
cases.push({ label: 'the loosest pair accepts everything that has a candidate; the strictest accepts nothing', run: () => {
  const m0 = scorePair(randomRecords(), 0.2, 0);
  const m1 = scorePair(randomRecords(), 0.8, 0.9);
  return m0.oos.accepted >= m1.oos.accepted && m1.inScope.accepted <= m0.inScope.accepted;
} });

// ── recommendation ──
const pair = (v: number, r: number, success: number, fa: number): PairMetrics => ({
  vectorThreshold: v, rerankFloor: r,
  inScope: { total: 100, accepted: success, refusedByVector: 0, refusedByRerank: 100 - success, success, wrongAnswer: 0 },
  oos: { total: 100, accepted: fa, refusedByVector: 0, refusedByRerank: 100 - fa },
  oosAuto: { total: 100, accepted: fa, refusedByVector: 0, refusedByRerank: 0 }, oosFile: { total: 0, accepted: 0, refusedByVector: 0, refusedByRerank: 0 },
});
cases.push({ label: 'recommend: highest in-scope success among pairs within the false-accept limit (an unsafe higher-success pair is skipped)', run: () => {
  const all = [pair(0.5, 0.5, 90, 4), pair(0.4, 0.3, 97, 20), pair(0.6, 0.6, 80, 0), pair(0.55, 0.5, 92, 5)];
  const r = recommend(all, 0.05);
  return r.best?.vectorThreshold === 0.55 && r.feasibleCount === 3 && r.ranked[0] === r.best && !isFeasible(all[1], 0.05);
} });
cases.push({ label: 'recommend: ties on success and false-accept go to the safer (higher floor, then higher vector) pair', run: () => {
  const all = [pair(0.4, 0.3, 90, 2), pair(0.5, 0.5, 90, 2), pair(0.6, 0.5, 90, 2), pair(0.7, 0.2, 90, 2)];
  const r = recommend(all, 0.05);
  return r.best?.rerankFloor === 0.5 && r.best?.vectorThreshold === 0.6 && compareBest(all[2], all[1]) < 0;
} });
cases.push({ label: 'recommend: no pair within the limit → no recommendation, fallback is the lowest false-accept pair', run: () => {
  const r = recommend([pair(0.5, 0.5, 90, 30), pair(0.6, 0.6, 70, 12)], 0.05);
  return r.best === null && r.fallback?.vectorThreshold === 0.6 && r.feasibleCount === 0;
} });
cases.push({ label: 'rankOf: position among feasible pairs; null when the pair is infeasible', run: () => {
  const all = [pair(0.5, 0.5, 90, 4), pair(0.6, 0.6, 80, 0), pair(0.4, 0.3, 97, 20)];
  const r = recommend(all, 0.05);
  return rankOf(r.ranked, all[0], 0.05) === 1 && rankOf(r.ranked, all[1], 0.05) === 2 && rankOf(r.ranked, all[2], 0.05) === null;
} });
cases.push({ label: 'false-accept limit is inclusive (exactly 5% passes)', run: () => isFeasible(pair(0.5, 0.5, 90, 5), 0.05) && !isFeasible(pair(0.5, 0.5, 90, 6), 0.05) });

// ── sampling, parsing ──
cases.push({ label: 'sample is deterministic for a seed, differs across seeds, never repeats, caps at the list length', run: () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  const a = sample(xs, 10, 42), b = sample(xs, 10, 42), c = sample(xs, 10, 43);
  return a.join() === b.join() && a.join() !== c.join() && new Set(a).size === 10 && sample(xs, 500, 1).length === 100 && sample(xs, 0, 1).length === 0;
} });
cases.push({ label: 'subSeed: independent streams per lecture and purpose, stable per input', run: () =>
  subSeed(42, 2, 1) === subSeed(42, 2, 1) && subSeed(42, 2, 1) !== subSeed(42, 3, 1) && subSeed(42, 2, 1) !== subSeed(42, 2, 2) && subSeed(42, 2, 1) !== subSeed(43, 2, 1) });
cases.push({ label: 'answerKeyOf ignores case and whitespace like the dedupe normaliser', run: () =>
  answerKeyOf('  Hello   World ') === answerKeyOf('hello world') && answerKeyOf('a') !== answerKeyOf('b') });
cases.push({ label: 'paraphrases: "<lecture>:<qa_id>" beats a bare qa_id; blank/missing → null', run: () => {
  const m = { 'Q1': 'bare', '7:Q1': 'scoped', 'Q2': '   ' };
  return resolveParaphrase(m, 7, 'Q1') === 'scoped' && resolveParaphrase(m, 8, 'Q1') === 'bare' && resolveParaphrase(m, 7, 'Q2') === null && resolveParaphrase(m, 7, 'Q9') === null;
} });
cases.push({ label: 'OOS file rows: header case-insensitive; bad lecture_id or empty question skipped and counted', run: () => {
  const r = parseOosRows([
    { Lecture_ID: 4, Question: ' What is the weather? ' }, { lecture_id: '5', question: 'Who won?' },
    { lecture_id: 'x', question: 'bad id' }, { lecture_id: 6, question: '' }, { lecture_id: 0, question: 'zero' }, { other: 1 },
  ]);
  return r.rows.length === 2 && r.rows[0].question === 'What is the weather?' && r.rows[1].lectureId === 5 && r.skipped === 4;
} });
cases.push({ label: 'recordKey: same inputs same key; different lecture, kind or text → different key', run: () => {
  const b = { kind: 'in' as const, lectureId: 1, goldQaId: 'A', question: 'q' };
  return recordKey(b) === recordKey({ ...b }) && recordKey(b) !== recordKey({ ...b, lectureId: 2 }) && recordKey(b) !== recordKey({ ...b, kind: 'oos-auto' }) && recordKey(b) !== recordKey({ ...b, question: 'r' });
} });

// ── output ──
const ctx = (over: Partial<SummaryContext> = {}): SummaryContext => ({
  database: 'localhost:1/x', embeddingModelVersion: 'emb:1', rerankerModelVersion: 'rr:1', questionMode: 'exact dataset questions',
  seed: 42, perLecture: 40, lectures: [2, 4], inScopeCount: 100, oosAutoCount: 100, oosFileCount: 0, maxFalseAccept: 0.05,
  current: pair(0.55, 0.5, 92, 5), currentOnGrid: true, ...over,
});
cases.push({ label: 'toCsv: header + one line per pair, feasible flag follows the limit', run: () => {
  const lines = toCsv([pair(0.5, 0.5, 90, 4), pair(0.4, 0.3, 97, 20)], 0.05).trim().split('\n');
  return lines.length === 3 && lines[0].startsWith('vector_threshold,rerank_floor') && lines[1].endsWith(',1') && lines[2].endsWith(',0');
} });
cases.push({ label: 'toMarkdown: recommendation, current-value rank, exact-question warning, gate legend', run: () => {
  const all = [pair(0.5, 0.5, 90, 4), pair(0.55, 0.5, 92, 5), pair(0.4, 0.3, 97, 20)];
  const md = toMarkdown(all, ctx());
  return /VECTOR_SIMILARITY_THRESHOLD=0\.55` and `RERANK_MIN_SCORE=0\.50/.test(md) && /ranks \*\*#1 of 2\*\* feasible/.test(md)
    && /exact dataset questions inflate similarity/.test(md) && /Refused by vector/.test(md) && /localhost:1\/x/.test(md);
} });
cases.push({ label: 'toMarkdown: infeasible current pair and "no recommendation" are stated plainly; paraphrase mode drops the warning', run: () => {
  const md = toMarkdown([pair(0.5, 0.5, 90, 30)], ctx({ current: pair(0.55, 0.5, 92, 30), questionMode: 'paraphrases (38 of 40 in-scope questions)' }));
  return /No pair keeps out-of-scope false-accept/.test(md) && /is \*\*not feasible\*\*/.test(md) && !/inflate similarity/.test(md) && /paraphrases \(38 of 40/.test(md);
} });
cases.push({ label: 'toMarkdown: an off-grid current pair is flagged as scored exactly', run: () =>
  /off the sweep grid/.test(toMarkdown([pair(0.5, 0.5, 90, 4)], ctx({ currentOnGrid: false }))) });

// ── the CLI stays read-only ──
cases.push({ label: 'tune-thresholds.ts sets default_transaction_read_only=on before the pool is created, verifies it, and contains no write SQL', run: () => {
  const src = fs.readFileSync(path.join(__dirname, 'tune-thresholds.ts'), 'utf8');
  const setAt = src.indexOf("process.env.PGOPTIONS");
  const poolAt = src.indexOf("import('../config/database')");
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return setAt >= 0 && setAt < poolAt && /default_transaction_read_only=on/.test(src) && /SHOW default_transaction_read_only/.test(src)
    && !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(code);
} });

let failures = 0;
for (const c of cases) {
  let pass = false;
  try { pass = c.run(); } catch (err) { console.log(`      threw: ${(err as Error).message}`); }
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures > 0 ? 1 : 0);
