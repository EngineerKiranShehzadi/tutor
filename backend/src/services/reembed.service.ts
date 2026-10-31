import { query } from '../config/database';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { exportActiveDataset, finishDatasetVersion, prepareDatasetVersion, type FinishDeps } from './dataset-version.service';

// Rebuilds lectures under the CURRENT embedding model, through the normal
// versioned pipeline — the path to take after switching EMBEDDING_PROVIDER or
// EMBEDDING_MODEL, when every stored vector belongs to the old model and each
// lecture reads STALE_EMBEDDING_MODEL. For each lecture: export the active
// dataset, upload it again (MERGE, matched by qa_id), embed every piece under
// the new model, validate, activate. Nothing is written to live chunks; the
// old version stays as the rollback target. One lecture at a time, so a
// hosted provider sees one build's requests at once.

export type ReembedOutcome =
  | 'UP_TO_DATE'         // every vector already comes from the current model
  | 'PLANNED'            // dry run: would re-embed chunksToEmbed pieces
  | 'ACTIVATED'          // rebuilt and live
  | 'PAUSED'             // the provider is down or rate-limiting; the build is kept, and a running
                         // backend's resume loop or `seed:retry -- <lectureId>` finishes it
  | 'FAILED'             // the build did not activate (see error); the old version is still live
  | 'SKIPPED_IN_FLIGHT'; // an update is already in flight for this lecture — finished the same way

export interface ReembedResult {
  lectureId: number;
  title: string;
  outcome: ReembedOutcome;
  qaPairs: number;
  chunksToEmbed: number;
  error?: string;
}

export async function reembedLectures(opts: { apply: boolean; lectureIds?: number[]; finish?: FinishDeps }): Promise<ReembedResult[]> {
  const { rows: lectures } = await query<{ id: number; title: string; in_flight: boolean }>(
    `SELECT l.id, l.title,
            EXISTS (SELECT 1 FROM dataset_versions v
                    WHERE v.lecture_id = l.id AND v.status IN ('BUILDING','READY_TO_ACTIVATE')) AS in_flight
       FROM lectures l
      WHERE l.active_version_id IS NOT NULL AND ($1::int[] IS NULL OR l.id = ANY($1::int[]))
      ORDER BY l.id`,
    [opts.lectureIds && opts.lectureIds.length > 0 ? opts.lectureIds : null]
  );

  const results: ReembedResult[] = [];
  for (const l of lectures) {
    const base = { lectureId: l.id, title: l.title, qaPairs: 0, chunksToEmbed: 0 };
    if (l.in_flight) {
      results.push({ ...base, outcome: 'SKIPPED_IN_FLIGHT' });
      continue;
    }
    try {
      const file = await exportActiveDataset(l.id);
      const prep = await prepareDatasetVersion(l.id, file, {
        mode: 'MERGE', dryRun: !opts.apply, filename: `reembed-${EMBEDDING_MODEL_VERSION}.xlsx`,
      });
      const p = prep.preview;
      const counts = { qaPairs: p.rowsUsed, chunksToEmbed: p.chunksToEmbed };
      if (prep.kind === 'DRY_RUN') {
        results.push({ ...base, ...counts, outcome: p.chunksToEmbed === 0 ? 'UP_TO_DATE' : 'PLANNED' });
      } else if (prep.kind === 'NOOP') {
        results.push({ ...base, ...counts, outcome: 'UP_TO_DATE' });
      } else {
        logger.info(`[REEMBED] Lecture #${l.id}: version #${prep.versionNo} — embedding ${p.chunksToEmbed} piece(s) under ${EMBEDDING_MODEL_VERSION}`);
        const fin = await finishDatasetVersion(prep.versionId, opts.finish ?? {});
        results.push({
          ...base, ...counts,
          outcome: fin.outcome === 'ACTIVATED' ? 'ACTIVATED' : fin.outcome === 'PAUSED' ? 'PAUSED' : 'FAILED',
          ...(fin.outcome === 'ACTIVATED' ? {} : { error: fin.error ?? fin.outcome }),
        });
      }
    } catch (err) {
      results.push({ ...base, outcome: 'FAILED', error: (err as Error).message.slice(0, 300) });
    }
  }
  return results;
}
