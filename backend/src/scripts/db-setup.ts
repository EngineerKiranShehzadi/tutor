import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import pool from '../config/database';

const dbHost = (): string => {
  const url = process.env.DATABASE_URL;
  if (url) {
    try { return new URL(url).hostname; } catch { return '(unparseable DATABASE_URL)'; }
  }
  return process.env.DB_HOST || 'localhost';
};

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

  // Numbered migrations (all idempotent), in order — includes dataset
  // versioning (006) and its answer-memory binding (007).
  const migrationsDir = join(__dirname, '../db/migrations');
  for (const file of readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    console.log(`Applying ${file}...`);
    await pool.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  console.log('✅ Database setup complete.');
  await pool.end();
};

run().catch(err => {
  console.error('❌ Database setup failed:', err.message);
  process.exit(1);
});
