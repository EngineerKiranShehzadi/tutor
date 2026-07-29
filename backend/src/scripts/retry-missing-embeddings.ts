import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { updateLectureStatus } from '../services/lecture.service';
import { logger } from '../utils/logger';

interface Chunk { id: number; chunk_text: string; }

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  if (isNaN(lectureId)) {
    console.error('Usage: npm run seed:retry [lectureId]');
    process.exit(1);
  }

  // Find chunks that are missing embeddings
  const { rows: missing } = await query<Chunk>(
    `SELECT id, chunk_text FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND embedding IS NULL
     ORDER BY id`,
    [lectureId]
  );

  if (missing.length === 0) {
    logger.info(`[RETRY] ✅ No missing embeddings for lecture #${lectureId} — all chunks are ready`);
    process.exit(0);
  }

  logger.info(`[RETRY] Found ${missing.length} chunks without embeddings for lecture #${lectureId}`);
  await updateLectureStatus(lectureId, 'EMBEDDING');

  let done = 0;
  for (let i = 0; i < missing.length; i++) {
    const chunk = missing[i];
    try {
      const embedding = await generateEmbedding(chunk.chunk_text);
      await query(
        'UPDATE lecture_qna_chunks SET embedding = $1 WHERE id = $2',
        [`[${embedding.join(',')}]`, chunk.id]
      );
      done++;
      logger.info(`[RETRY] Embedded ${i + 1}/${missing.length} (id=${chunk.id})`);
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      logger.error(`[RETRY] ❌ Failed chunk id=${chunk.id}`, err);
    }
  }

  await updateLectureStatus(lectureId, 'READY');
  logger.info(`[RETRY] ✅ Done — ${done}/${missing.length} chunks embedded. Lecture #${lectureId} → READY`);
  process.exit(0);
}

main().catch(err => {
  logger.error('[RETRY] ❌ Fatal:', err);
  process.exit(1);
});
