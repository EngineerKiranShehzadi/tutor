/**
 * RAG evaluation module — adapted from the LlamaIndex chunk-size evaluation
 * pattern (Faithfulness + Relevancy evaluators, response time) to this
 * project's Gemini + BGE stack.
 *
 * This project has no chunk_size to sweep (chunks are fixed Q&A rows, not
 * size-split text), so instead we sweep the retrieval candidate pool size
 * (how many chunks vector search returns before the reranker narrows to
 * the final top N used for generation).
 *
 * Usage: npm run eval:rag [lectureId]
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks } from '../services/rerank.service';
import { generateAnswer } from '../services/llm-gemini.service';
import { getLectureById } from '../services/lecture.service';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const NUM_EVAL_QUESTIONS = 20;
const RERANK_TOP_N = 5;
const CANDIDATE_POOL_SIZES = [5, 10, 15, 20, 30];

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured. Please add it to your .env file.');
  process.exit(1);
}
const judgeClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const judgeModel = judgeClient.getGenerativeModel({
  model: 'gemini-2.5-flash',
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

async function loadEvalQuestions(lectureId: number, n: number): Promise<string[]> {
  const { rows } = await query<{ question: string }>(
    `SELECT question FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NOT NULL
     ORDER BY RANDOM() LIMIT $2`,
    [lectureId, n]
  );
  return rows.map(r => r.question);
}

interface PoolResult {
  poolSize: number;
  avgResponseTimeMs: number;
  faithfulnessRate: number;
  relevancyRate: number;
}

async function evaluatePool(
  lectureId: number,
  lectureTitle: string,
  questions: string[],
  candidatePoolSize: number
): Promise<PoolResult> {
  let totalTime = 0;
  let faithfulPass = 0;
  let relevantPass = 0;

  for (const question of questions) {
    const start = Date.now();

    const qEmbedding = await generateEmbedding(question, true);
    const candidates = await searchChunks(qEmbedding, lectureId, candidatePoolSize);
    const chunks = candidates.length > 0 ? await rerankChunks(question, candidates, RERANK_TOP_N) : [];
    const answer = chunks.length > 0
      ? await generateAnswer(question, chunks, lectureTitle, [])
      : 'I could not find this information in this lecture.';

    totalTime += Date.now() - start;

    const context = chunks.map((c: QnaChunk) => c.chunk_text).join('\n\n');
    const [faithful, relevant] = await Promise.all([
      judgeFaithfulness(answer, context),
      judgeRelevancy(question, answer),
    ]);
    if (faithful) faithfulPass++;
    if (relevant) relevantPass++;
  }

  const n = questions.length;
  return {
    poolSize: candidatePoolSize,
    avgResponseTimeMs: totalTime / n,
    faithfulnessRate: faithfulPass / n,
    relevancyRate: relevantPass / n,
  };
}

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  if (isNaN(lectureId)) {
    console.error('Usage: npm run eval:rag [lectureId]');
    process.exit(1);
  }

  const lecture = await getLectureById(lectureId);
  logger.info(`[EVAL] Target lecture #${lectureId}: "${lecture.title}"`);

  const questions = await loadEvalQuestions(lectureId, NUM_EVAL_QUESTIONS);
  if (questions.length === 0) {
    logger.error(`[EVAL] No embedded chunks found for lecture #${lectureId} — run embedding first`);
    process.exit(1);
  }
  logger.info(`[EVAL] Sampled ${questions.length} real questions from the dataset as the eval set`);
  logger.info(`[EVAL] Sweeping candidate pool size (retrieval width before rerank → top ${RERANK_TOP_N})`);

  const results: PoolResult[] = [];
  for (const poolSize of CANDIDATE_POOL_SIZES) {
    logger.info(`[EVAL] Running pool size = ${poolSize} ...`);
    const result = await evaluatePool(lectureId, lecture.title, questions, poolSize);
    results.push(result);
    logger.info(
      `[EVAL] pool=${poolSize} → avg_time=${result.avgResponseTimeMs.toFixed(0)}ms, ` +
      `faithfulness=${(result.faithfulnessRate * 100).toFixed(1)}%, relevancy=${(result.relevancyRate * 100).toFixed(1)}%`
    );
  }

  console.log('\n=== RAG Evaluation Summary ===');
  console.table(results.map(r => ({
    'Candidate Pool': r.poolSize,
    'Avg Response Time (ms)': r.avgResponseTimeMs.toFixed(0),
    'Faithfulness %': (r.faithfulnessRate * 100).toFixed(1),
    'Relevancy %': (r.relevancyRate * 100).toFixed(1),
  })));

  process.exit(0);
}

main().catch(err => {
  logger.error('[EVAL] ❌ Fatal:', err);
  process.exit(1);
});
