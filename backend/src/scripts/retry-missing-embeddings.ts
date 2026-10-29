import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { updateLectureStatus } from '../services/lecture.service';
import { logger } from '../utils/logger';

interface Chunk { id: number; chunk_text: string; }

async function main() {
  const arg = process.argv[2];
  const lectureId = parseInt(arg ?? '', 10);
  if (!arg || isNaN(lectureId)) {
    console.error('Usage: npm run seed:retry -- <lectureId>');
    console.error('The lecture id is required — there is no default, so this can');
    console.error('never silently run against the wrong lecture.');
    process.exit(1);
  }

  // A lecture with a dataset build in flight is finished by the versioned
  // pipeline (embeds only what's missing, validates, then publishes it).
  const { rows: inflight } = await query<{ id: number }>(
    `SELECT id FROM dataset_versions WHERE lecture_id = $1 AND status IN ('BUILDING','READY_TO_ACTIVATE') ORDER BY id DESC LIMIT 1`,
    [lectureId]
  );
  if (inflight[0]) {
    const { finishDatasetVersion } = await import('../services/dataset-version.service');
    const result = await finishDatasetVersion(inflight[0].id);
    logger.info(`[RETRY] Version id=${inflight[0].id}: ${result.outcome}${result.error ? ' — ' + result.error : ''}`);
    process.exit(result.outcome === 'ACTIVATED' ? 0 : 1);
  }

  // Legacy path — find chunks that are missing embeddings
  // local_embedding (1024 dims, BAAI/bge-large-en-v1.5) is the column vector
  // search actually reads. The older `embedding` column (3072 dims, Gemini) is
  // unused — targeting it here meant this script matched every row, generated
  // 1024-dim vectors, and then failed on every insert with a dimension
  // mismatch, while still reporting the lecture as READY at the end.
  const { rows: missing } = await query<Chunk>(
    `SELECT id, chunk_text FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND local_embedding IS NULL
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
      // isQuery stays false: these are stored passages, not student questions.
      const embedding = await generateEmbedding(chunk.chunk_text);
      await query(
        'UPDATE lecture_qna_chunks SET local_embedding = $1::vector WHERE id = $2',
        [`[${embedding.join(',')}]`, chunk.id]
      );
      done++;
      logger.info(`[RETRY] Embedded ${i + 1}/${missing.length} (id=${chunk.id})`);
      // No pacing delay: the embedding server is local and sequential, so there
      // is no remote rate limit to respect. The previous 400ms per chunk added
      // ~17 minutes to a full-corpus retry for no benefit.
    } catch (err) {
      logger.error(`[RETRY] ❌ Failed chunk id=${chunk.id}`, err);
    }
  }

  const failed = missing.length - done;
  if (failed > 0) {
    // Previously READY was set unconditionally, so a run in which every
    // chunk failed still reported success and left a lecture that looked
    // ready but could answer nothing.
    logger.error(
      `[RETRY] ⚠️  ${failed}/${missing.length} chunk(s) still have no embedding. ` +
      `Lecture #${lectureId} left as EMBEDDING — fix the cause (is the embedding ` +
      `server running?) and run this again.`
    );
    process.exit(1);
  }

  await updateLectureStatus(lectureId, 'READY');
  logger.info(`[RETRY] ✅ Done — ${done}/${missing.length} chunk(s) embedded. Lecture #${lectureId} → READY`);
  process.exit(0);
}

main().catch(err => {
  logger.error('[RETRY] ❌ Fatal:', err);
  process.exit(1);
});
