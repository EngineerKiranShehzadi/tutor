/**
 * Before/after comparison for dedupeAndSelect(), same methodology as the
 * reorder comparison: same question sample, same fixed candidate pool,
 * retrieval+rerank done once and shared by both conditions, only the final
 * context-selection step differs.
 *
 * DEDUP OFF = the pipeline as it existed before this feature: raw top-5 of
 * the reranked list (duplicates included), then reorderForContext (already
 * shipped, proven neutral on its own).
 * DEDUP ON  = the new pipeline: dedupeAndSelect(rankedAll, 5) then
 * reorderForContext — the real production call sequence in chat.service.ts.
 *
 * Also reports wasted-slot counts (Step 1 style) and final chunk count per
 * condition, since dedup ON can legitimately return fewer than 5.
 *
 * Usage: npm run eval:dedup-comparison [lectureId]
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks, dedupeAndSelect, reorderForContext } from '../services/rerank.service';
import { generateAnswer } from '../services/llm-gemini.service';
import { getLectureById } from '../services/lecture.service';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const NUM_EVAL_QUESTIONS = 8;
const CANDIDATE_POOL_SIZE = 15;

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}
const judgeClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const judgeModel = judgeClient.getGenerativeModel({
  model: 'gemini-flash-lite-latest',
  generationConfig: { temperature: 0 },
});

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function askJudge(prompt: string, attempt = 1): Promise<boolean> {
  try {
    const result = await judgeModel.generateContent(prompt);
    return result.response.text().trim().toUpperCase().startsWith('PASS');
  } catch (err: unknown) {
    const msg = String((err as Error).message ?? '');
    const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');
    const isOverloaded = msg.includes('503') || msg.toLowerCase().includes('service unavailable') || msg.toLowerCase().includes('high demand');
    if ((isRateLimit || isOverloaded) && attempt <= 5) {
      const wait = Math.pow(2, attempt) * 4000;
      logger.warn(`[JUDGE] Rate limited on attempt ${attempt}/5 — retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return askJudge(prompt, attempt + 1);
    }
    throw err;
  }
}

function judgeFaithfulness(answer: string, context: string): Promise<boolean> {
  return askJudge(`You are evaluating an AI tutor's answer for faithfulness to its source material.

Context (retrieved lecture content):
${context || '(no context was retrieved)'}

Answer:
${answer}

Does the answer ONLY contain information that is supported by the context above, with no fabricated or invented facts?
Respond with exactly one word: PASS or FAIL.`);
}

function judgeRelevancy(question: string, answer: string): Promise<boolean> {
  return askJudge(`You are evaluating whether an AI tutor's answer actually addresses the student's question.

Question: ${question}
Answer: ${answer}

Does the answer directly and adequately address the question?
Respond with exactly one word: PASS or FAIL.`);
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, ' ');
}

function countWastedSlots(chunks: QnaChunk[]): number {
  const groups = new Map<string, number>();
  for (const c of chunks) {
    const key = normalizeAnswer(c.answer);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let wasted = 0;
  for (const count of groups.values()) {
    if (count >= 2) wasted += count - 1;
  }
  return wasted;
}

interface Prepared {
  question: string;
  rankedAll: QnaChunk[];
  wastedSlotsRawTop5: number;
}

async function prepareQuestions(lectureId: number): Promise<Prepared[]> {
  const { rows } = await query<{ question: string }>(
    `SELECT question FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NOT NULL
     ORDER BY RANDOM() LIMIT $2`,
    [lectureId, NUM_EVAL_QUESTIONS]
  );

  const prepared: Prepared[] = [];
  for (const { question } of rows) {
    const embedding = await generateEmbedding(question, true);
    const candidates = await searchChunks(embedding, lectureId, CANDIDATE_POOL_SIZE);
    const rankedAll = candidates.length > 0 ? await rerankChunks(question, candidates, candidates.length) : [];
    prepared.push({ question, rankedAll, wastedSlotsRawTop5: countWastedSlots(rankedAll.slice(0, 5)) });
  }
  return prepared;
}

interface ConditionResult {
  question: string;
  wastedSlotsRawTop5: number;
  chunkCount: number;
  faithful: boolean;
  relevant: boolean;
  responseTimeMs: number;
}

async function runCondition(
  prepared: Prepared[],
  lectureTitle: string,
  dedupOn: boolean
): Promise<ConditionResult[]> {
  const results: ConditionResult[] = [];
  for (const [i, { question, rankedAll, wastedSlotsRawTop5 }] of prepared.entries()) {
    if (i > 0) await sleep(15_000);
    const start = Date.now();

    const chunks = dedupOn
      ? dedupeAndSelect(rankedAll, 5).selected
      : rankedAll.slice(0, 5);
    const contextChunks = reorderForContext(chunks);

    const answer = contextChunks.length > 0
      ? await generateAnswer(question, contextChunks, lectureTitle, [])
      : 'I could not find this information in this lecture.';
    const responseTimeMs = Date.now() - start;

    const context = contextChunks.map(c => c.chunk_text).join('\n\n');
    const [faithful, relevant] = await Promise.all([
      judgeFaithfulness(answer, context),
      judgeRelevancy(question, answer),
    ]);

    results.push({ question, wastedSlotsRawTop5, chunkCount: chunks.length, faithful, relevant, responseTimeMs });
  }
  return results;
}

function summarize(label: string, results: ConditionResult[]) {
  const n = results.length;
  const faithfulRate = results.filter(r => r.faithful).length / n;
  const relevantRate = results.filter(r => r.relevant).length / n;
  const avgTime = results.reduce((s, r) => s + r.responseTimeMs, 0) / n;
  const avgChunkCount = results.reduce((s, r) => s + r.chunkCount, 0) / n;
  console.log(`\n[${label}] Faithfulness: ${(faithfulRate * 100).toFixed(1)}% | Relevancy: ${(relevantRate * 100).toFixed(1)}% | Avg response time: ${avgTime.toFixed(0)}ms | Avg chunks used: ${avgChunkCount.toFixed(1)}`);
  return { faithfulRate, relevantRate, avgTime, avgChunkCount };
}

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  const lecture = await getLectureById(lectureId);
  logger.info(`[EVAL-DEDUP] Target lecture #${lectureId}: "${lecture.title}"`);

  logger.info(`[EVAL-DEDUP] Preparing ${NUM_EVAL_QUESTIONS} questions (retrieval+rerank done once, shared by both conditions)...`);
  const prepared = await prepareQuestions(lectureId);
  const withWaste = prepared.filter(p => p.wastedSlotsRawTop5 > 0);
  logger.info(`[EVAL-DEDUP] ${withWaste.length}/${prepared.length} questions have wasted slots in the raw top-5`);

  logger.info(`[EVAL-DEDUP] Running condition: DEDUP OFF (raw top-5, duplicates included)...`);
  const resultsOff = await runCondition(prepared, lecture.title, false);
  console.log('\n=== DEDUP OFF condition complete — printing now in case ON fails ===');
  const off = summarize('DEDUP OFF', resultsOff);

  logger.info(`[EVAL-DEDUP] Running condition: DEDUP ON...`);
  const resultsOn = await runCondition(prepared, lecture.title, true);

  console.log(`\n=== Overall (all ${prepared.length} questions) ===`);
  const on = summarize('DEDUP ON ', resultsOn);
  console.log(`\nRelevancy delta (ON - OFF): ${((on.relevantRate - off.relevantRate) * 100).toFixed(1)} pp`);
  console.log(`Faithfulness delta (ON - OFF): ${((on.faithfulRate - off.faithfulRate) * 100).toFixed(1)} pp`);
  console.log(`Avg chunk count delta (ON - OFF): ${(on.avgChunkCount - off.avgChunkCount).toFixed(1)}`);

  process.exit(0);
}

main().catch(err => {
  logger.error('[EVAL-DEDUP] ❌ Fatal:', err);
  process.exit(1);
});
