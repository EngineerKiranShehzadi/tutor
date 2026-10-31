/**
 * Re-embeds every lecture under the CURRENT embedding model, through the
 * normal versioned pipeline (services/reembed.service.ts). Run it after
 * switching EMBEDDING_PROVIDER / EMBEDDING_MODEL: until then every lecture is
 * "not ready" (STALE_EMBEDDING_MODEL).
 *
 * Dry run by default — prints, per lecture, how many pieces would be embedded
 * (with a hosted provider, that is what you pay for). --apply builds and
 * activates one lecture at a time.
 *
 * Usage:
 *   npm run reembed:all                      # dry run, every lecture
 *   npm run reembed:all -- --lectures 2,5    # dry run, these lectures
 *   npm run reembed:all -- --apply           # rebuild and activate
 *
 * --apply on a database that is not on this machine also needs
 * REEMBED_ALLOW_REMOTE=1, so it can't reach production by accident.
 */
import pool from '../config/database';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import { assertRetrievalProvidersConfigured } from '../config/retrieval-providers';
import { reembedLectures } from '../services/reembed.service';

const dbTarget = (): { host: string; database: string } => {
  const url = process.env.DATABASE_URL;
  if (url) {
    try { const u = new URL(url); return { host: u.hostname, database: u.pathname.replace(/^\//, '') }; } catch { /* fall through */ }
  }
  return { host: process.env.DB_HOST || 'localhost', database: process.env.DB_NAME || '?' };
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const li = argv.indexOf('--lectures');
  const lectureIds = li >= 0 ? (argv[li + 1] ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0) : undefined;
  if (li >= 0 && (!lectureIds || lectureIds.length === 0)) throw new Error('--lectures needs ids, e.g. --lectures 2,5');

  // Thresholds are re-tuned AFTER re-embedding (tune:thresholds reads the new vectors).
  assertRetrievalProvidersConfigured({ checkThresholds: false });
  const target = dbTarget();
  const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(target.host);
  console.log(`Database: ${target.host}/${target.database}${local ? '' : '  (NOT this machine)'}`);
  console.log(`Embedding model: ${EMBEDDING_MODEL_VERSION}`);
  console.log(apply ? 'Mode: APPLY — lectures are rebuilt and activated one at a time\n' : 'Mode: dry run — nothing is written (add --apply to rebuild)\n');
  if (apply && !local && process.env.REEMBED_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing --apply on ${target.host}: set REEMBED_ALLOW_REMOTE=1 for that one command if this is intended.`);
  }

  const results = await reembedLectures({ apply, lectureIds });
  for (const r of results) {
    console.log(`#${String(r.lectureId).padEnd(4)} ${r.outcome.padEnd(18)} ${String(r.qaPairs).padStart(5)} Q&As  ${String(r.chunksToEmbed).padStart(6)} pieces to embed  ${r.title}${r.error ? `\n       ${r.error}` : ''}`);
  }
  const toEmbed = results.reduce((s, r) => s + r.chunksToEmbed, 0);
  const bad = results.filter(r => r.outcome === 'FAILED' || r.outcome === 'PAUSED' || r.outcome === 'SKIPPED_IN_FLIGHT');
  console.log(`\n${results.length} lecture(s), ${toEmbed} piece(s) ${apply ? 'embedded' : 'to embed'}.`);
  if (bad.length > 0) {
    console.log(`${bad.length} not done. A PAUSED or in-flight build is kept: a running backend finishes it within a minute,`
      + ' or `npm run seed:retry -- <lectureId>` finishes it now. A FAILED one can simply be run again.');
  }
  process.exitCode = bad.length > 0 ? 1 : 0;
}

main()
  .catch(err => { console.error((err as Error).message); process.exitCode = 1; })
  .finally(() => pool.end());
