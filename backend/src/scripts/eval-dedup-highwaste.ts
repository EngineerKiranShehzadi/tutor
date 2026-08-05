/**
 * Dedup before/after, restricted to the highest-duplicate-count questions
 * specifically (wastedSlots >= 3 in the raw top-5), not a general random
 * sample. Screening (retrieval+rerank) is free/local, so we can screen a
 * wide pool cheaply and only spend Gemini quota on the filtered subset that
 * gives the fix its best chance of showing a measurable effect.
 *
 * Uses ONE model for generation throughout both conditions (set via
 * GENERATION_MODEL below) to avoid the confound risk flagged in review.
 *
 * Usage: npm run eval:dedup-highwaste [lectureId]
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks, dedupeAndSelect, reorderForContext } from '../services/rerank.service';
import { getLectureById } from '../services/lecture.service';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const SCREEN_POOL_SIZE = 40;       // wide screening pool (free — no Gemini calls)
const MIN_WASTED_SLOTS = 3;        // filter: only the worst-affected questions
const MAX_EVAL_QUESTIONS = 8;      // cap on how many filtered questions get generate+judge
const CANDIDATE_POOL_SIZE = 15;
const GENERATION_MODEL = 'gemini-3.1-flash-lite'; // single model, both conditions

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}
const genClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const genModel = genClient.getGenerativeModel({
  model: GENERATION_MODEL,
  generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
});
const judgeModel = genClient.getGenerativeModel({
  model: 'gemini-flash-lite-latest',
  generationConfig: { temperature: 0 },
});

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function callWithRetry<T>(fn: () => Promise<T>, label: string, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = String((err as Error).message ?? '');
    const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');
    const isOverloaded = msg.includes('503') || msg.toLowerCase().includes('service unavailable') || msg.toLowerCase().includes('high demand');
    if ((isRateLimit || isOverloaded) && attempt <= 5) {
      const wait = Math.pow(2, attempt) * 4000;
      logger.warn(`[${label}] Rate limited on attempt ${attempt}/5 — retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return callWithRetry(fn, label, attempt + 1);
    }
    throw err;
  }
}

const SYSTEM_PROMPT = `You are a lecture-specific AI tutor. Answer the student's question using ONLY the provided lecture Q&A context.
Rules:
1. Use ONLY the provided context. Do NOT use outside knowledge.
2. If the answer is not in the context, respond: "I could not find this information in this lecture."
3. Explain in simple, student-friendly language.
4. Do NOT invent or guess information not present in the context.
5. Keep answers concise and educational.`;

function buildContext(chunks: QnaChunk[]): string {
  return chunks.map(c => `[Lecture Content]\nTopic: ${c.topic ?? 'General'}\nQ: ${c.question}\nA: ${c.answer}`).join('\n\n');
}

async function generateAnswerFixedModel(question: string, chunks: QnaChunk[]): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\nLecture Q&A Context:\n${buildContext(chunks)}\n\nCurrent Student Question:\n${question}`;
  return callWithRetry(async () => {
    const result = await genModel.generateContent(prompt);
    const answer = result.response.text();
    if (!answer?.trim()) throw new Error('Empty response');
    return answer;
  }, 'GEN');
}

async function askJudge(prompt: string): Promise<boolean> {
  return callWithRetry(async () => {
    const result = await judgeModel.generateContent(prompt);
    return result.response.text().trim().toUpperCase().startsWith('PASS');
  }, 'JUDGE');
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

async function screenAndFilter(lectureId: number): Promise<Prepared[]> {
  const { rows } = await query<{ question: string }>(
    `SELECT question FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NOT NULL
     ORDER BY RANDOM() LIMIT $2`,
    [lectureId, SCREEN_POOL_SIZE]
  );

  const screened: Prepared[] = [];
  for (const { question } of rows) {
    const embedding = await generateEmbedding(question, true);
    const candidates = await searchChunks(embedding, lectureId, CANDIDATE_POOL_SIZE);
    const rankedAll = candidates.length > 0 ? await rerankChunks(question, candidates, candidates.length) : [];
    const wastedSlotsRawTop5 = countWastedSlots(rankedAll.slice(0, 5));
    screened.push({ question, rankedAll, wastedSlotsRawTop5 });
  }

  const filtered = screened
    .filter(p => p.wastedSlotsRawTop5 >= MIN_WASTED_SLOTS)
    .sort((a, b) => b.wastedSlotsRawTop5 - a.wastedSlotsRawTop5)
    .slice(0, MAX_EVAL_QUESTIONS);

  logger.info(`[EVAL-HW] Screened ${screened.length} questions → ${filtered.length} with wastedSlots >= ${MIN_WASTED_SLOTS}`);
  return filtered;
}

interface ConditionResult {
  question: string;
  wastedSlotsRawTop5: number;
  chunkCount: number;
  faithful: boolean;
  relevant: boolean;
  responseTimeMs: number;
}

async function runCondition(prepared: Prepared[], dedupOn: boolean): Promise<ConditionResult[]> {
  const results: ConditionResult[] = [];
  for (const [i, { question, rankedAll, wastedSlotsRawTop5 }] of prepared.entries()) {
    if (i > 0) await sleep(15_000);
    const start = Date.now();

    const chunks = dedupOn ? dedupeAndSelect(rankedAll, 5).selected : rankedAll.slice(0, 5);
    const contextChunks = reorderForContext(chunks);

    const answer = contextChunks.length > 0
      ? await generateAnswerFixedModel(question, contextChunks)
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
  logger.info(`[EVAL-HW] Target lecture #${lectureId}: "${lecture.title}"`);
  logger.info(`[EVAL-HW] Generation model: ${GENERATION_MODEL} (fixed, both conditions) | Judge model: gemini-flash-lite-latest`);

  const prepared = await screenAndFilter(lectureId);
  if (prepared.length === 0) {
    logger.error(`[EVAL-HW] No questions found with wastedSlots >= ${MIN_WASTED_SLOTS} in a pool of ${SCREEN_POOL_SIZE} — cannot run high-waste comparison`);
    process.exit(1);
  }
  const avgWaste = prepared.reduce((s, p) => s + p.wastedSlotsRawTop5, 0) / prepared.length;
  console.log(`\nHigh-waste subset: ${prepared.length} questions, avg wastedSlots = ${avgWaste.toFixed(1)} (vs ~1.2 in the general sample)`);
  prepared.forEach(p => console.log(`  - "${p.question.slice(0, 70)}..." (wastedSlots=${p.wastedSlotsRawTop5})`));

  logger.info(`[EVAL-HW] Running condition: DEDUP OFF...`);
  const resultsOff = await runCondition(prepared, false);
  console.log('\n=== DEDUP OFF complete — printing now in case ON fails ===');
  const off = summarize('DEDUP OFF', resultsOff);

  logger.info(`[EVAL-HW] Running condition: DEDUP ON...`);
  const resultsOn = await runCondition(prepared, true);

  console.log(`\n=== Overall (${prepared.length} high-waste questions) ===`);
  const on = summarize('DEDUP ON ', resultsOn);
  console.log(`\nRelevancy delta (ON - OFF): ${((on.relevantRate - off.relevantRate) * 100).toFixed(1)} pp`);
  console.log(`Faithfulness delta (ON - OFF): ${((on.faithfulRate - off.faithfulRate) * 100).toFixed(1)} pp`);
  console.log(`Avg chunk count delta (ON - OFF): ${(on.avgChunkCount - off.avgChunkCount).toFixed(1)}`);

  process.exit(0);
}

main().catch(err => {
  logger.error('[EVAL-HW] ❌ Fatal:', err);
  process.exit(1);
});
