/**
 * Re-embeds all lecture_qna_chunks using the local Python embedding server.
 * Run: npx ts-node --transpile-only scripts/reembed-local.ts
 * Requires: python scripts/embedding_server.py running on port 5001
 */
import { query } from '../src/config/database';
import { generateEmbedding } from '../src/services/embedding.service';
import { logger } from '../src/utils/logger';

const BATCH = 20;

async function main() {
  const { rows: chunks } = await query<{ id: number; chunk_text: string }>(
    'SELECT id, chunk_text FROM lecture_qna_chunks WHERE local_embedding IS NULL ORDER BY id'
  );

  logger.info(`Re-embedding ${chunks.length} chunks in batches of ${BATCH}…`);

  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (c) => {
        const vec = await generateEmbedding(c.chunk_text);
        await query(
          'UPDATE lecture_qna_chunks SET local_embedding = $1 WHERE id = $2',
          [`[${vec.join(',')}]`, c.id]
        );
      })
    );
    done += batch.length;
    logger.info(`  ${done}/${chunks.length} done`);
  }

  logger.info('All chunks re-embedded successfully.');
  process.exit(0);
}

main().catch((err) => { logger.error('Re-embed failed:', err); process.exit(1); });
