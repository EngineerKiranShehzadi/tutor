import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import pool from '../config/database';

// `npm run db:setup` and `npm run db:migrate` both run this: the full schema
// sequence, safe to run any number of times on a new or an existing database.
//
//   1. schema.sql    base tables (idempotent, always applied)
//   2. migrate.sql   lectures, chunks, chat, sessions… (idempotent, always applied)
//   3. migrations/NNN_*.sql in order, recorded in the schema_migrations ledger:
//        - already applied with the same content → skipped
//        - new → applied, then recorded
//        - applied, but the file changed since → applied again and re-recorded
//          (every migration here is written to be idempotent), with a warning
//      Each file and its ledger row commit together, so a failure leaves the
//      ledger exactly matching what was applied.
//
// A database set up before the ledger existed has every migration applied once
// more on the first run (harmless: they are idempotent) and is then tracked.

const dbHost = (): string => {
  const url = process.env.DATABASE_URL;
  if (url) {
    try { return new URL(url).hostname; } catch { return '(unparseable DATABASE_URL)'; }
  }
  return process.env.DB_HOST || 'localhost';
};

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT        PRIMARY KEY,
    checksum   TEXT        NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// Canonical checksum going forward: LF-normalized, so the same migration
// hashes the same whether it's checked out with LF or CRLF line endings.
// The SQL actually executed below is still the file's exact on-disk content,
// untouched — only the ledger comparison is normalized.
const canonicalChecksum = (s: string): string => sha(s.replace(/\r\n/g, '\n'));

// Every ledger row recorded before this fix existed (e.g. migrations 002-019,
// recorded from a Windows checkout) was hashed from whatever line endings
// were actually on disk at apply time — CRLF, unnormalized. Converting this
// machine's LF content back to CRLF reproduces that legacy hash, so a row
// matching it is "no change", not "reapply" — without this, a one-line
// normalization fix would have made EVERY pre-existing CRLF-recorded row
// look changed on every machine, which is worse than the bug it fixes
// (2026-11-04, owner caught this testing the first version of this patch).
const legacyCrlfChecksum = (s: string): string => sha(s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));

export interface MigrationReport { applied: string[]; reapplied: string[]; skipped: string[] }

export async function applyMigrations(migrationsDir = join(__dirname, '../db/migrations')): Promise<MigrationReport> {
  await pool.query(LEDGER_SQL);
  const { rows } = await pool.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations');
  const done = new Map(rows.map(r => [r.filename, r.checksum]));
  const report: MigrationReport = { applied: [], reapplied: [], skipped: [] };

  for (const file of readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = canonicalChecksum(sql);
    const prev = done.get(file);
    if (prev === checksum) { report.skipped.push(file); continue; }
    if (prev === legacyCrlfChecksum(sql)) {
      // Unchanged content, just a pre-normalization legacy hash — no SQL to
      // run, just quietly migrate the ledger row to the canonical checksum
      // so this machine (and every machine after it) stops re-deriving the
      // legacy hash on every run.
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [checksum, file]);
      report.skipped.push(file);
      continue;
    }
    if (prev !== undefined) console.warn(`⚠️  ${file} changed since it was applied — applying it again (migrations are idempotent).`);
    console.log(`Applying ${file}...`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()`,
        [file, checksum]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
    (prev === undefined ? report.applied : report.reapplied).push(file);
  }
  return report;
}

const run = async () => {
  const host = dbHost();
  console.log(`Target database host: ${host}`);
  if (!/^(localhost|127\.0\.0\.1)$/.test(host) && process.env.ALLOW_REMOTE_DB_SETUP !== '1') {
    throw new Error(`refusing to run db:setup against non-local host "${host}" (set ALLOW_REMOTE_DB_SETUP=1 to override)`);
  }

  const schemaPath = join(__dirname, '../db/schema.sql');
  const migratePath = join(__dirname, '../db/migrate.sql');

  console.log('Applying schema...');
  await pool.query(readFileSync(schemaPath, 'utf8'));
  console.log('Schema applied.');

  console.log('Running migrations...');
  try {
    await pool.query(readFileSync(migratePath, 'utf8'));
    console.log('Migrations complete.');
  } catch (err: any) {
    if (err.message?.includes('extension "vector" is not available')) {
      console.warn('pgvector extension not installed — vector/RAG features will be unavailable.');
      console.warn('Install pgvector and re-run this script to enable them.');
    } else {
      throw err;
    }
  }

  // Numbered migrations — includes dataset versioning (006) and its
  // answer-memory binding (007) — tracked in schema_migrations.
  const r = await applyMigrations();
  console.log(`Numbered migrations: ${r.applied.length} applied, ${r.reapplied.length} re-applied (changed), ${r.skipped.length} already up to date.`);

  console.log('✅ Database setup complete.');
};

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch(err => {
      console.error('❌ Database setup failed:', err.message);
      process.exit(1);
    });
}
