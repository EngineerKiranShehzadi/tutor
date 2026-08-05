/**
 * Step 4: before/after comparison for reorderForContext().
 *
 * Samples 20 real questions ONCE, runs retrieval+rerank ONCE per question
 * (identical candidates/top-5 for both conditions — only the order fed to
 * the LLM differs), then generates+judges twice per question: reorder OFF
 * (current rerank order) vs reorder ON (lost-in-the-middle mitigation).
 *
 * Also cross-references against the Step 1 duplicate-answer-text diagnostic
 * (computed inline on the same top-5s) to see whether reordering moves
 * Relevancy specifically for questions that had wasted context slots.
 *
 * Usage: npm run eval:reorder-comparison [lectureId]
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks, reorderForContext } from '../services/rerank.service';
import { generateAnswer } from '../services/llm-gemini.service';
import { getLectureById } from '../services/lecture.service';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const NUM_EVAL_QUESTIONS = 8;
const CANDIDATE_POOL_SIZE = 15; // fixed — matches production default in chat.service.ts
const RERANK_TOP_N = 5;

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}
const judgeClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
// gemini-2.5-flash's free-tier daily quota (20 req/day) was exhausted by
// generateAnswer() calls alone, and gemini-1.5-flash is fully retired (404).
// Judge on gemini-flash-lite-latest — a separate quota bucket with capacity.
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
  top5: QnaChunk[];
  wastedSlots: number;
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
    const top5 = candidates.length > 0 ? await rerankChunks(question, candidates, RERANK_TOP_N) : [];
    prepared.push({ question, top5, wastedSlots: countWastedSlots(top5) });
  }
  return prepared;
}

interface ConditionResult {
  question: string;
  wastedSlots: number;
  faithful: boolean;
  relevant: boolean;
  responseTimeMs: number;
}

async function runCondition(
  prepared: Prepared[],
  lectureTitle: string,
  reorderOn: boolean
): Promise<ConditionResult[]> {
  const results: ConditionResult[] = [];
  for (const [i, { question, top5, wastedSlots }] of prepared.entries()) {
    // Gemini free tier allows 5 req/min; each question makes 3 calls
    // (1 generate + 2 judges), so pace requests to avoid constant 429s.
    if (i > 0) await sleep(15_000);
    const start = Date.now();
    const contextChunks = reorderOn ? reorderForContext(top5) : top5;
    const answer = contextChunks.length > 0
      ? await generateAnswer(question, contextChunks, lectureTitle, [])
      : 'I could not find this information in this lecture.';
    const responseTimeMs = Date.now() - start;

    const context = contextChunks.map(c => c.chunk_text).join('\n\n');
    const [faithful, relevant] = await Promise.all([
      judgeFaithfulness(answer, context),
      judgeRelevancy(question, answer),
    ]);

    results.push({ question, wastedSlots, faithful, relevant, responseTimeMs });
  }
  return results;
}

function summarize(label: string, results: ConditionResult[]) {
  const n = results.length;
  const faithfulRate = results.filter(r => r.faithful).length / n;
  const relevantRate = results.filter(r => r.relevant).length / n;
  const avgTime = results.reduce((s, r) => s + r.responseTimeMs, 0) / n;
  console.log(`\n[${label}] Faithfulness: ${(faithfulRate * 100).toFixed(1)}% | Relevancy: ${(relevantRate * 100).toFixed(1)}% | Avg response time: ${avgTime.toFixed(0)}ms`);
  return { faithfulRate, relevantRate, avgTime };
}

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  const lecture = await getLectureById(lectureId);
  logger.info(`[EVAL-CMP] Target lecture #${lectureId}: "${lecture.title}"`);

  logger.info(`[EVAL-CMP] Preparing ${NUM_EVAL_QUESTIONS} questions (retrieval+rerank done once, shared by both conditions)...`);
  const prepared = await prepareQuestions(lectureId);
  const withWaste = prepared.filter(p => p.wastedSlots > 0);
  logger.info(`[EVAL-CMP] ${withWaste.length}/${prepared.length} questions have wasted context slots (duplicate answer text in top-5)`);

  logger.info(`[EVAL-CMP] Running condition: reorder OFF...`);
  const resultsOff = await runCondition(prepared, lecture.title, false);
  console.log('\n=== REORDER OFF condition complete — printing now in case ON fails ===');
  const off = summarize('REORDER OFF', resultsOff);

  logger.info(`[EVAL-CMP] Running condition: reorder ON...`);
  const resultsOn = await runCondition(prepared, lecture.title, true);

  console.log(`\n=== Overall (all ${prepared.length} questions) ===`);
  const on = summarize('REORDER ON ', resultsOn);
  console.log(`\nRelevancy delta (ON - OFF): ${((on.relevantRate - off.relevantRate) * 100).toFixed(1)} pp`);
  console.log(`Faithfulness delta (ON - OFF): ${((on.faithfulRate - off.faithfulRate) * 100).toFixed(1)} pp (expected ~0, same facts either way)`);

  // Cross-reference: split by whether the question had wasted context slots
  const idxWithWaste = prepared.map((p, i) => (p.wastedSlots > 0 ? i : -1)).filter(i => i >= 0);
  const idxNoWaste = prepared.map((p, i) => (p.wastedSlots === 0 ? i : -1)).filter(i => i >= 0);

  console.log(`\n=== Cross-reference: questions WITH wasted slots (${idxWithWaste.length}/${prepared.length}) ===`);
  if (idxWithWaste.length > 0) {
    summarize('REORDER OFF (wasted-slot subset)', idxWithWaste.map(i => resultsOff[i]));
    summarize('REORDER ON  (wasted-slot subset)', idxWithWaste.map(i => resultsOn[i]));
  } else {
    console.log('(none in this sample)');
  }

  console.log(`\n=== Cross-reference: questions WITHOUT wasted slots (${idxNoWaste.length}/${prepared.length}) ===`);
  if (idxNoWaste.length > 0) {
    summarize('REORDER OFF (clean subset)', idxNoWaste.map(i => resultsOff[i]));
    summarize('REORDER ON  (clean subset)', idxNoWaste.map(i => resultsOn[i]));
  } else {
    console.log('(none in this sample)');
  }

  process.exit(0);
}

main().catch(err => {
  logger.error('[EVAL-CMP] ❌ Fatal:', err);
  process.exit(1);
});
