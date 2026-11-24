/**
 * golden-cli.ts — run the golden case bank from the terminal (no GraphQL/UI).
 *
 * Lets you drive drafting + review without a running server or an admin token,
 * so the whole benchmark loop works from the shell:
 *   generate → approve-all → export:gold → capture:rag → golden-evaluator.cjs
 *
 * Usage:
 *   ts-node --transpile-only src/scripts/golden-cli.ts generate <lectureId> <datasetVersionId>
 *   ts-node --transpile-only src/scripts/golden-cli.ts approve-all <datasetVersionId> [reviewerUuid]
 *   ts-node --transpile-only src/scripts/golden-cli.ts list <datasetVersionId> [status]
 *
 * approve-all only approves DRAFT cases that already pass the approval gate
 * (answerable with evidence); deterministic drafts qualify by construction.
 * Per-case human review via the reviewGoldenCase mutation remains the norm —
 * this is a convenience, not a replacement for review.
 */
import pool from '../config/database';
import { generateDraftCases, approveAllDrafts, listGoldenCases } from '../services/golden-case.service';
import { logger } from '../utils/logger';

const int = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};

async function run(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case 'generate': {
      const r = await generateDraftCases(int(a, 'lectureId'), int(b, 'datasetVersionId'));
      logger.info(`[GOLD-CLI] generate: ${r.created} created, ${r.skipped} already existed (of ${r.candidateChunks} Q&A chunks) for version ${r.datasetVersionId}`);
      break;
    }
    case 'approve-all': {
      const r = await approveAllDrafts(b ?? null, int(a, 'datasetVersionId'));
      logger.info(`[GOLD-CLI] approve-all: ${r.approved} draft case(s) approved for version ${r.datasetVersionId}`);
      break;
    }
    case 'list': {
      const rows = await listGoldenCases(int(a, 'datasetVersionId'), b);
      logger.info(`[GOLD-CLI] ${rows.length} case(s)${b ? ` (status=${b})` : ''} for version ${a}:`);
      for (const c of rows) {
        logger.info(`  [${c.reviewStatus}] ${c.caseKey} · ${c.category} · evidence=[${c.expectedChunkIds.join(',')}] · ${c.question.slice(0, 70)}`);
      }
      break;
    }
    default:
      throw new Error('Usage: golden-cli.ts <generate|approve-all|list> ...  (see file header)');
  }
}

run()
  .then(() => pool.end())
  .catch(async err => { logger.error(`[GOLD-CLI] ${(err as Error).message}`); await pool.end().catch(() => {}); process.exitCode = 1; });
