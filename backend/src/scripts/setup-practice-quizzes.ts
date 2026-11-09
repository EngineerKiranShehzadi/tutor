import { readFileSync } from 'fs';
import { join } from 'path';
import pool from '../config/database';

const target = process.env.DATABASE_URL || '';
const host = target ? (() => { try { return new URL(target).hostname; } catch { return '(invalid database URL)'; } })() : (process.env.DB_HOST || 'localhost');
const local = host === 'localhost' || host === '127.0.0.1';

async function main() {
  console.log('Practice quiz migration target: '+host);
  if(!local && process.env.ALLOW_REMOTE_DB_SETUP !== '1') {
    throw new Error('Refusing remote database changes. For your verified DEV database only, set ALLOW_REMOTE_DB_SETUP=1.');
  }
  const migration = readFileSync(join(__dirname,'../db/migrations/023_practice_quizzes.sql'),'utf8');
  await pool.query(migration);
  console.log('Practice quiz tables ready. Existing courses, lectures and vector embeddings were not modified.');
}
main().then(()=>pool.end()).catch(async err=>{console.error(err.message);await pool.end();process.exitCode=1;});
