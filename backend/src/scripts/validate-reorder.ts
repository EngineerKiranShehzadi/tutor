/**
 * One-off validation (not wired into the app): runs one real question through
 * the live pipeline (embed -> searchChunks -> rerankChunks) to get a real
 * top-5 with real chunk IDs, then visually confirms reorderForContext()
 * places rank 1 at index 0, rank 2 at the LAST index, and rank 5 (worst)
 * dead-center — before this is trusted enough to wire into chat.service.ts.
 *
 * Usage: npm run validate:reorder [lectureId]
 */
import { generateEmbedding } from '../services/embedding.service';
import { searchChunks } from '../services/vector-search.service';
import { rerankChunks, reorderForContext } from '../services/rerank.service';
import { query } from '../config/database';
import { logger } from '../utils/logger';

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);

  const { rows } = await query<{ question: string }>(
    `SELECT question FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NOT NULL
     ORDER BY RANDOM() LIMIT 1`,
    [lectureId]
  );
  const question = rows[0]?.question;
  if (!question) {
    logger.error('No embedded chunks found — run embedding first');
    process.exit(1);
  }

  logger.info(`Question: "${question}"`);

  const qEmbedding = await generateEmbedding(question, true);
  const candidates = await searchChunks(qEmbedding, lectureId, 15);
  const top5 = await rerankChunks(question, candidates, 5);

  console.log('\n=== BEFORE reorderForContext (rerank order, best first) ===');
  top5.forEach((c, i) => {
    console.log(`  index ${i} | rank ${i + 1}${i === 0 ? ' (best)' : i === 4 ? ' (worst)' : ''} | chunk #${c.id} | similarity=${c.similarity?.toFixed(3)}`);
  });

  const reordered = reorderForContext(top5);
  const rankOf = new Map(top5.map((c, i) => [c.id, i + 1]));

  console.log('\n=== AFTER reorderForContext (what the LLM will actually see) ===');
  reordered.forEach((c, i) => {
    const rank = rankOf.get(c.id);
    const label = rank === 1 ? ' <-- BEST (expect index 0)' : rank === 2 ? ' <-- 2ND-BEST (expect LAST index)' : rank === 5 ? ' <-- WORST (expect dead-center)' : '';
    console.log(`  index ${i} | original rank ${rank} | chunk #${c.id}${label}`);
  });

  const bestIdx = reordered.findIndex(c => rankOf.get(c.id) === 1);
  const secondIdx = reordered.findIndex(c => rankOf.get(c.id) === 2);
  const worstIdx = reordered.findIndex(c => rankOf.get(c.id) === top5.length);
  const lastIdx = reordered.length - 1;
  const middleIdx = Math.floor(reordered.length / 2);

  console.log('\n=== Assertions ===');
  console.log(`Best (rank 1) at index 0: ${bestIdx === 0 ? 'PASS' : 'FAIL'} (actual index ${bestIdx})`);
  console.log(`2nd-best (rank 2) at LAST index (${lastIdx}), not adjacent to best: ${secondIdx === lastIdx ? 'PASS' : 'FAIL'} (actual index ${secondIdx})`);
  console.log(`Worst (rank ${top5.length}) dead-center (index ${middleIdx}): ${worstIdx === middleIdx ? 'PASS' : 'FAIL'} (actual index ${worstIdx})`);

  process.exit(0);
}

main().catch(err => {
  logger.error('Fatal:', err);
  process.exit(1);
});
