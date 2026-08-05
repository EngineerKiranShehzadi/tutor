/**
 * Diagnostic (measurement only, no fix): for each of N sampled eval questions,
 * run the real retrieval + rerank pipeline (no generation, no LLM calls) and
 * check whether 2+ of the top-5 reranked chunks share IDENTICAL answer text
 * after normalization — i.e. wasted context slots on repeated content, not
 * a dataset problem (paraphrase-variant questions are intentional).
 *
 * Only ANSWER TEXT equality counts as a duplicate. Same `topic` with
 * different answer content is NOT flagged.
 *
 * Usage: npm run diagnose:duplicates [lectureId]
 */
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks } from '../services/rerank.service';
import { getLectureById } from '../services/lecture.service';
import { logger } from '../utils/logger';

const NUM_EVAL_QUESTIONS = 20;
const CANDIDATE_POOL_SIZE = 15;
const RERANK_TOP_N = 5;

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadEvalQuestions(lectureId: number, n: number): Promise<{ id: number; question: string }[]> {
  const { rows } = await query<{ id: number; question: string }>(
    `SELECT id, question FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NOT NULL
     ORDER BY RANDOM() LIMIT $2`,
    [lectureId, n]
  );
  return rows;
}

interface QuestionResult {
  sourceChunkId: number;
  question: string;
  top5: { id: number; question: string; answer: string }[];
  duplicateGroups: { id: number; question: string }[][];
  wastedSlots: number;
}

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  if (isNaN(lectureId)) {
    console.error('Usage: npm run diagnose:duplicates [lectureId]');
    process.exit(1);
  }

  const lecture = await getLectureById(lectureId);
  logger.info(`[DIAG] Target lecture #${lectureId}: "${lecture.title}"`);

  const evalQuestions = await loadEvalQuestions(lectureId, NUM_EVAL_QUESTIONS);
  if (evalQuestions.length === 0) {
    logger.error(`[DIAG] No embedded chunks found for lecture #${lectureId} — run embedding first`);
    process.exit(1);
  }
  logger.info(`[DIAG] Sampled ${evalQuestions.length} real questions as the diagnostic set`);

  const results: QuestionResult[] = [];

  for (const { id: sourceChunkId, question } of evalQuestions) {
    const qEmbedding = await generateEmbedding(question, true);
    const candidates = await searchChunks(qEmbedding, lectureId, CANDIDATE_POOL_SIZE);
    const top5 = candidates.length > 0 ? await rerankChunks(question, candidates, RERANK_TOP_N) : [];

    // Group top-5 chunks by normalized answer text
    const groups = new Map<string, { id: number; question: string; answer: string }[]>();
    for (const chunk of top5) {
      const key = normalizeAnswer(chunk.answer);
      const list = groups.get(key) ?? [];
      list.push({ id: chunk.id, question: chunk.question, answer: chunk.answer });
      groups.set(key, list);
    }

    const duplicateGroups = [...groups.values()].filter(g => g.length >= 2);
    const wastedSlots = duplicateGroups.reduce((sum, g) => sum + (g.length - 1), 0);

    results.push({
      sourceChunkId,
      question,
      top5: top5.map(c => ({ id: c.id, question: c.question, answer: c.answer })),
      duplicateGroups,
      wastedSlots,
    });
  }

  const questionsWithDuplicates = results.filter(r => r.duplicateGroups.length > 0);
  const totalWastedSlots = results.reduce((sum, r) => sum + r.wastedSlots, 0);

  console.log('\n=== Duplicate-Answer-Text Diagnostic ===');
  console.log(`Questions sampled: ${results.length}`);
  console.log(
    `Questions with 2+ chunks sharing identical answer text in top-5: ` +
    `${questionsWithDuplicates.length}/${results.length} ` +
    `(${((questionsWithDuplicates.length / results.length) * 100).toFixed(1)}%)`
  );
  console.log(`Total wasted context slots across all ${results.length} questions: ${totalWastedSlots}`);
  console.log(
    `Average wasted slots per question (over full sample): ${(totalWastedSlots / results.length).toFixed(2)}`
  );

  if (questionsWithDuplicates.length > 0) {
    console.log('\n--- Examples ---');
    for (const r of questionsWithDuplicates) {
      console.log(`\nQ (source chunk #${r.sourceChunkId}): "${r.question}"`);
      for (const group of r.duplicateGroups) {
        console.log(
          `  DUPLICATE ANSWER shared by ${group.length} chunks (${group.length - 1} wasted slot(s)):`
        );
        for (const c of group) {
          console.log(`    - chunk #${c.id}: "${c.question}"`);
        }
      }
    }
  } else {
    console.log('\nNo exact-match duplicate answer text found in any top-5 result.');
  }

  process.exit(0);
}

main().catch(err => {
  logger.error('[DIAG] ❌ Fatal:', err);
  process.exit(1);
});
