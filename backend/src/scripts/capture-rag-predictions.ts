/**
 * capture-rag-predictions.ts — live retrieval capture for the golden benchmark.
 *
 * Reads a reviewed/approved gold.json (the SAME shape backend/evaluation/
 * golden-evaluator.cjs validates) and, for each case, runs the real retrieval
 * pipeline against the case's PINNED dataset version, then writes a
 * predictions.json the deterministic evaluator can score — with no manual
 * ranking entry.
 *
 * It is the committed capture adapter the project audit found missing. It does
 * NOT touch the live chat path, does NOT change any table, and reuses the exact
 * production retrieval/rerank functions (never a re-implementation), so the
 * captured numbers reflect what students actually get.
 *
 * Five ranked-ID stages are captured per case:
 *   1. vectorIds          — raw vector ranking (cosine, separate explicit run)
 *   2. hybridIds          — vector+FTS fused pool BEFORE reranking (reranker input)
 *   3. dedupSelectionIds  — reranked pool after answer-dedup + relevance floor,
 *                           BEFORE the context budget (the new, optional stage)
 *   4. rerankedIds        — full reranker ranking of the whole pool
 *   5. finalContextIds    — the <=5 chunks actually eligible for answer context
 *
 * Raw-vector and hybrid are measured as SEPARATE executions, so the deployed
 * hybrid path is never mislabelled as a raw-vector run.
 *
 * Out of scope here (kept deterministic / explicit on purpose):
 *   - citationChunkIds / answerCorrect / grounding come from a human review
 *     (and optionally answer generation); this script leaves citationChunkIds
 *     empty and all human verdicts UNREVIEWED. The evaluator excludes
 *     UNREVIEWED, so nothing is silently scored as a pass.
 *   - Phoenix mirroring and the admin run-record write are later stages.
 *
 * Usage:
 *   ts-node --transpile-only src/scripts/capture-rag-predictions.ts \
 *     <gold.json> <out-predictions.json> [--candidate-limit=15] [--final-context=5]
 *
 * Live dependencies: Postgres, the configured embedding provider and the
 * configured reranker. A per-case failure is recorded on that case (empty
 * stage lists + captureError) and the run continues; it never aborts the file.
 */
import { readFileSync, writeFileSync } from 'fs';
import pool from '../config/database';
import { generateEmbedding, EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import { searchChunkCandidates, searchChunksHybrid } from '../services/vector-search.service';
import { rerankChunks, dedupeAndSelect, reorderForContext, DEFAULT_MIN_RERANK_SCORE, RERANKER_MODEL_VERSION } from '../services/rerank.service';
import { generateAnswer } from '../services/answer-generation.service';
import { getLectureById } from '../services/lecture.service';
import { judgeLlm, JUDGE_MODEL } from './live-llm';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { QnaChunk } from '../types';

// The tutor does not emit per-sentence citation markers (its system prompt
// forbids "Source N" labels), so the chunks an answer is grounded in ARE its
// final-context chunks. When --answer is set we therefore record
// citationChunkIds = finalContextIds: citation precision/recall then measures
// whether the context the answer actually used carried the expected evidence.

// Mirrors chat.service.ts's direct-path constants so the capture matches the
// deployed pipeline. Overridable from the CLI for controlled experiments.
const DEFAULT_CANDIDATE_LIMIT = 15;
const DEFAULT_FINAL_CONTEXT = 5;
// Bump when the judge prompts below change, so stored judge results stay
// comparable only within the same prompt version.
const JUDGE_PROMPT_VERSION = 'v1';

type JudgeVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';
interface JudgeResult {
  answerCorrect: JudgeVerdict;
  grounded: JudgeVerdict;
  model: string;
  promptVersion: string;
}

// Optional LLM-as-judge. Output is an AID stored SEPARATELY from human
// verdicts — it never becomes a gold label and never gates approval/release.
async function judgeOne(prompt: string): Promise<JudgeVerdict> {
  try {
    return (await judgeLlm(prompt)).trim().toUpperCase().startsWith('PASS') ? 'PASS' : 'FAIL';
  } catch {
    return 'UNKNOWN';
  }
}

async function judgeAnswer(question: string, answer: string, context: string, reference?: string): Promise<JudgeResult> {
  const grounded = await judgeOne(
    `You check whether an AI tutor's ANSWER is fully supported by the provided CONTEXT.\n` +
    `Reply with exactly PASS if every claim in the answer is supported by the context, or FAIL otherwise.\n\n` +
    `CONTEXT:\n${context.slice(0, 6000)}\n\nANSWER:\n${answer.slice(0, 3000)}\n\nVerdict (PASS or FAIL):`
  );
  const answerCorrect = reference && reference.trim()
    ? await judgeOne(
        `Compare an AI tutor's ANSWER to the REFERENCE answer for the same QUESTION.\n` +
        `Reply with exactly PASS if the answer is factually consistent with the reference, or FAIL otherwise.\n\n` +
        `QUESTION:\n${question.slice(0, 1000)}\n\nREFERENCE:\n${reference.slice(0, 3000)}\n\nANSWER:\n${answer.slice(0, 3000)}\n\nVerdict (PASS or FAIL):`)
    : 'UNKNOWN';
  return { answerCorrect, grounded, model: JUDGE_MODEL, promptVersion: JUDGE_PROMPT_VERSION };
}

interface GoldCase {
  id: string;
  lectureId: number;
  datasetVersionId: number;
  question: string;
  category: string;
  answerable: boolean;
  expectedChunkIds: number[];
  expectedAnswer?: string; // reference answer, used by the optional judge only
  reviewed: boolean;
  reviewedBy: string;
}

interface PredictionCase {
  id: string;
  lectureId: number;
  datasetVersionId: number;
  vectorIds: number[];
  hybridIds: number[];
  dedupSelectionIds: number[];
  rerankedIds: number[];
  finalContextIds: number[];
  citationChunkIds: number[];
  refused: boolean;
  latencyMs: number;
  human: { answerCorrect: 'UNREVIEWED'; grounded: 'UNREVIEWED'; citationValid: 'UNREVIEWED' };
  // Populated only with --answer; a human reviews these for correctness/grounding.
  answer?: string;
  // Populated only with --judge; an LLM aid kept SEPARATE from `human`.
  judge?: JudgeResult;
  captureError?: string;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const map = (chunks: QnaChunk[]): number[] => chunks.map(c => c.id);

const parseArg = (name: string, fallback: number): number => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const v = Number(hit.split('=')[1]);
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a positive integer`);
  return v;
};

function loadGold(path: string): GoldCase[] {
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Cannot read/parse gold file "${path}": ${(e as Error).message}`); }
  const d = doc as { schemaVersion?: number; cases?: unknown };
  if (d?.schemaVersion !== 1 || !Array.isArray(d.cases) || d.cases.length === 0) {
    throw new Error('Gold file must be {"schemaVersion":1,"cases":[...]} with at least one case');
  }
  for (const c of d.cases as GoldCase[]) {
    if (!c || typeof c.id !== 'string' || !Number.isInteger(c.lectureId) || !Number.isInteger(c.datasetVersionId)) {
      throw new Error(`Gold case is missing id / lectureId / datasetVersionId: ${JSON.stringify(c)?.slice(0, 120)}`);
    }
    // Only reviewed cases may be captured as benchmark truth (prompt decision 6).
    if (c.reviewed !== true || typeof c.reviewedBy !== 'string' || !c.reviewedBy.trim()) {
      throw new Error(`Gold case ${c.id} is not human-reviewed (reviewed:true + reviewedBy required)`);
    }
  }
  return d.cases as GoldCase[];
}

const lectureTitleCache = new Map<number, string>();
async function lectureTitle(lectureId: number): Promise<string> {
  const hit = lectureTitleCache.get(lectureId);
  if (hit !== undefined) return hit;
  const lec = await getLectureById(lectureId);
  const title = (lec as { title?: string })?.title ?? `Lecture ${lectureId}`;
  lectureTitleCache.set(lectureId, title);
  return title;
}

async function captureCase(c: GoldCase, candidateLimit: number, finalBudget: number, withAnswer: boolean, withJudge: boolean): Promise<PredictionCase> {
  const base: PredictionCase = {
    id: c.id, lectureId: c.lectureId, datasetVersionId: c.datasetVersionId,
    vectorIds: [], hybridIds: [], dedupSelectionIds: [], rerankedIds: [], finalContextIds: [],
    citationChunkIds: [], refused: false, latencyMs: 0,
    human: { answerCorrect: 'UNREVIEWED', grounded: 'UNREVIEWED', citationValid: 'UNREVIEWED' },
  };
  const started = Date.now();
  try {
    const embedding = await generateEmbedding(c.question, true);

    // Stage 1 + 2 are SEPARATE explicit executions (raw vector vs hybrid).
    const [vectorRows, hybridPool] = await Promise.all([
      searchChunkCandidates(embedding, c.lectureId, candidateLimit, c.datasetVersionId),
      searchChunksHybrid(embedding, c.question, c.lectureId, candidateLimit, c.datasetVersionId),
    ]);
    base.vectorIds = map(vectorRows);
    base.hybridIds = map(hybridPool); // fused + context-expanded pool = the reranker's input

    if (hybridPool.length === 0) {
      base.refused = true; // nothing retrieved → same not-found outcome as the live path
      base.latencyMs = Date.now() - started;
      return base;
    }

    // Stage 4: full reranker ranking of the whole pool (not just the top N).
    const rankedAll = await rerankChunks(c.question, hybridPool, hybridPool.length);
    base.rerankedIds = map(rankedAll);

    // Stage 3: post-dedup selection = dedup + relevance floor over the WHOLE
    // ranked pool (budget set to the pool size so it is never the limiter).
    // Stage 5: final context = the same survivors capped to the context budget.
    // Both reuse the production dedupeAndSelect so the floor/dedup rules match.
    const { selected: survivors } = dedupeAndSelect(rankedAll, rankedAll.length, DEFAULT_MIN_RERANK_SCORE);
    base.dedupSelectionIds = map(survivors);
    const finalChunks = survivors.slice(0, finalBudget);
    base.finalContextIds = map(finalChunks);
    base.refused = base.finalContextIds.length === 0; // all below floor → not-found

    // --answer: generate the grounded answer exactly as production does
    // (reordered context) and record the final-context chunks as citations.
    if (withAnswer && finalChunks.length > 0) {
      const title = await lectureTitle(c.lectureId);
      base.answer = await generateAnswer(c.question, reorderForContext(finalChunks), title);
      base.citationChunkIds = [...base.finalContextIds];

      // Optional judge — an aid, recorded separately from `human` verdicts.
      if (withJudge) {
        const context = finalChunks.map(ch => ch.chunk_text).join('\n\n');
        base.judge = await judgeAnswer(c.question, base.answer, context, c.expectedAnswer);
      }
    }
  } catch (err) {
    base.captureError = String((err as Error)?.message ?? 'capture failed').slice(0, 300);
    logger.warn(`[CAPTURE] case=${c.id} reason=CAPTURE_ERROR msg=${base.captureError}`);
  }
  base.latencyMs = Date.now() - started;
  return base;
}

async function main(): Promise<void> {
  const [goldPath, outPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!goldPath || !outPath) {
    throw new Error('Usage: capture-rag-predictions.ts <gold.json> <out-predictions.json> [--candidate-limit=15] [--final-context=5]');
  }
  const candidateLimit = parseArg('candidate-limit', DEFAULT_CANDIDATE_LIMIT);
  const finalBudget = parseArg('final-context', DEFAULT_FINAL_CONTEXT);
  const withJudge = flag('judge');
  const withAnswer = flag('answer') || withJudge; // the judge needs an answer to judge
  const gold = loadGold(goldPath);

  logger.info(`[CAPTURE] ${gold.length} case(s) · candidateLimit=${candidateLimit} finalContext=${finalBudget} answer=${withAnswer} judge=${withJudge} ` +
    `embedder=${EMBEDDING_MODEL_VERSION} reranker=${RERANKER_MODEL_VERSION} hybrid=${env.RETRIEVAL.HYBRID_SEARCH_ENABLED}`);

  const cases: PredictionCase[] = [];
  let errors = 0;
  for (const c of gold) {
    const pred = await captureCase(c, candidateLimit, finalBudget, withAnswer, withJudge);
    if (pred.captureError) errors++;
    cases.push(pred);
    logger.info(`[CAPTURE] ${c.id}: vector=${pred.vectorIds.length} hybrid=${pred.hybridIds.length} ` +
      `reranked=${pred.rerankedIds.length} dedup=${pred.dedupSelectionIds.length} final=${pred.finalContextIds.length} ` +
      `refused=${pred.refused} ${pred.latencyMs}ms${pred.captureError ? ' ERROR' : ''}`);
  }

  // `meta` pins exactly what produced this capture so a run is reproducible and
  // never compared across mismatched configs. The evaluator ignores unknown
  // top-level keys, so this does not affect scoring.
  const out = {
    schemaVersion: 1,
    meta: {
      capturedAt: new Date().toISOString(),
      candidateLimit, finalContextBudget: finalBudget,
      answerCaptured: withAnswer,
      judgeApplied: withJudge,
      ...(withJudge ? { judgeModel: JUDGE_MODEL, judgePromptVersion: JUDGE_PROMPT_VERSION } : {}),
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
      rerankerModelVersion: RERANKER_MODEL_VERSION,
      rerankMinScore: DEFAULT_MIN_RERANK_SCORE,
      hybridSearchEnabled: env.RETRIEVAL.HYBRID_SEARCH_ENABLED,
      rrfK: env.RETRIEVAL.RRF_K,
      caseCount: cases.length,
      captureErrors: errors,
    },
    cases,
  };
  // wx: never overwrite an existing capture; 0600: predictions can carry chunk IDs.
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  logger.info(`[CAPTURE] wrote ${cases.length} prediction(s) → ${outPath}${errors ? ` (${errors} with capture errors)` : ''}`);
  logger.info('[CAPTURE] Next: human-review citations/correctness, then score with evaluation/golden-evaluator.cjs');
}

// Providers keep HTTP keep-alive sockets open, which can hold the event loop
// after the work is done; exit explicitly once the pool is closed.
main()
  .then(async () => { await pool.end().catch(() => {}); process.exit(0); })
  .catch(async err => { logger.error(`[CAPTURE] ${(err as Error).message}`); await pool.end().catch(() => {}); process.exit(1); });
