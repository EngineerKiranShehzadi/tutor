import { query } from '../config/database';
import { logger } from '../utils/logger';

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

  // Legacy path (no in-flight version): repair only the ACTIVE version's missing vectors.
  const { retryMissingEmbeddings } = await import('../services/dataset-version.service');
  const result = await retryMissingEmbeddings(lectureId);
  (result.exitCode === 0 ? logger.info : logger.error)(`[RETRY] ${result.message}`);
  process.exit(result.exitCode);
}

main().catch(err => {
  logger.error('[RETRY] ❌ Fatal:', err);
  process.exit(1);
});
