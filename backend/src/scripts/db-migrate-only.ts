import pool from '../config/database';
import { applyMigrations } from './db-setup';

/**
 * Applies ONLY the numbered migrations in src/db/migrations, through the same
 * schema_migrations ledger and the same per-file transaction db:setup uses.
 *
 * Why this exists separately from `npm run db:migrate`.
 *
 * That command runs the whole setup sequence: schema.sql and migrate.sql in
 * full, unconditionally, on every run, and only then the numbered migrations.
 * migrate.sql is where an unguarded `ALTER COLUMN ... USING NULL` once wiped
 * every embedding in the database (see the comment at the top of that block,
 * incident 2026-10-30). It is guarded now, but adding one table is no reason
 * to re-run several hundred lines of schema repair against a live database.
 *
 * So this runs the numbered migrations and nothing else. It is also why there
 * is no ALLOW_REMOTE_DB_SETUP check here: that flag guards the setup sequence,
 * which this deliberately does not run.
 *
 * It prints the plan before touching anything, and stops rather than silently
 * re-applying a migration the ledger already records. A re-apply means the
 * file changed after it was applied, which on a production database deserves
 * a decision, not a default. Pass ALLOW_MIGRATION_REAPPLY=1 when that is what
 * you actually want.
 */
const run = async (): Promise<void> => {
  const plan = await applyMigrations(undefined, { dryRun: true });

  console.log(`Up to date : ${plan.skipped.length} migration(s)`);
  console.log(`New        : ${plan.applied.length ? plan.applied.join(', ') : 'none'}`);
  console.log(`Re-apply   : ${plan.reapplied.length ? plan.reapplied.join(', ') : 'none'}`);

  if (plan.applied.length === 0 && plan.reapplied.length === 0) {
    console.log('\nNothing to do. The database already has every migration.');
    return;
  }

  if (plan.reapplied.length > 0 && process.env.ALLOW_MIGRATION_REAPPLY !== '1') {
    throw new Error(
      `refusing to re-apply ${plan.reapplied.join(', ')}: the file changed after it was applied. `
      + 'Check the change is safe to run again, then set ALLOW_MIGRATION_REAPPLY=1.'
    );
  }

  console.log('');
  const r = await applyMigrations();
  console.log(`\n✅ ${r.applied.length} applied, ${r.reapplied.length} re-applied, ${r.skipped.length} already up to date.`);
};

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch(err => {
      console.error('❌ Migration failed:', err.message);
      process.exit(1);
    });
}
