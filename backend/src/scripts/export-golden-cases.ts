/**
 * export-golden-cases.ts — dump a dataset version's APPROVED golden cases to a
 * gold.json file in the exact shape the deterministic evaluator and the live
 * capture adapter expect. This is the committed bridge from the reviewed case
 * bank (migration 045 / golden-case.service) to capture-rag-predictions.ts, so
 * no gold.json is ever hand-authored.
 *
 * Usage:
 *   ts-node --transpile-only src/scripts/export-golden-cases.ts <datasetVersionId> <out-gold.json>
 */
import { writeFileSync } from 'fs';
import pool from '../config/database';
import { exportApprovedGold } from '../services/golden-case.service';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const [versionArg, outPath] = process.argv.slice(2);
  const datasetVersionId = Number(versionArg);
  if (!Number.isSafeInteger(datasetVersionId) || datasetVersionId < 1 || !outPath) {
    throw new Error('Usage: export-golden-cases.ts <datasetVersionId> <out-gold.json>');
  }
  const gold = await exportApprovedGold(datasetVersionId);
  if (gold.cases.length === 0) {
    throw new Error(`No APPROVED golden cases for dataset version ${datasetVersionId}. Draft + review some first.`);
  }
  // wx: never overwrite an existing gold file; 0600: it can carry chunk IDs.
  writeFileSync(outPath, JSON.stringify(gold, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  logger.info(`[GOLD-EXPORT] wrote ${gold.cases.length} approved case(s) for version ${datasetVersionId} → ${outPath}`);
  logger.info('[GOLD-EXPORT] Next: npm run capture:rag -- <this gold.json> <predictions.json>');
}

main()
  .then(() => pool.end())
  .catch(async err => { logger.error(`[GOLD-EXPORT] ${(err as Error).message}`); await pool.end().catch(() => {}); process.exitCode = 1; });
