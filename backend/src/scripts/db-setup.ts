import { readFileSync } from 'fs';
import { join } from 'path';
import pool from '../config/database';

const run = async () => {
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

  console.log('✅ Database setup complete.');
  await pool.end();
};

run().catch(err => {
  console.error('❌ Database setup failed:', err.message);
  process.exit(1);
});
