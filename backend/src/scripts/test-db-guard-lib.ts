/**
 * Shared guard for test scripts that write to the database.
 *
 * Refuses to continue unless the database the app would connect to is on this
 * machine AND its name contains "test" or "pipe" — the rule test-dataset-
 * pipeline.ts always used. It resolves the target exactly as config/database.ts
 * does (DATABASE_URL if set, else DB_HOST/DB_PORT/DB_NAME), after loading
 * backend/.env the way config/env.ts does, so a DATABASE_URL that only lives in
 * .env is seen too. Prints the target (never the password) before anything runs.
 *
 * Call assertThrowawayDb() before the first query, e.g. right after the imports.
 */
import dotenv from 'dotenv';
import path from 'path';

export interface DbTarget {
  ok: boolean;
  host: string;
  port: string;
  database: string;
  source: 'DATABASE_URL' | 'DB_HOST/DB_PORT/DB_NAME' | 'unparseable DATABASE_URL';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function evaluateDbTarget(e: NodeJS.ProcessEnv): DbTarget {
  const url = e.DATABASE_URL ?? '';
  let host: string, port: string, database: string, source: DbTarget['source'];
  if (url) {
    try {
      const u = new URL(url);
      host = u.hostname;
      port = u.port || '5432';
      database = decodeURIComponent(u.pathname.replace(/^\//, ''));
      source = 'DATABASE_URL';
    } catch {
      return { ok: false, host: '?', port: '?', database: '?', source: 'unparseable DATABASE_URL' };
    }
  } else {
    host = e.DB_HOST ?? 'localhost';
    port = e.DB_PORT ?? '5432';
    database = e.DB_NAME ?? 'askaitutor';
    source = 'DB_HOST/DB_PORT/DB_NAME';
  }
  const ok = LOCAL_HOSTS.has(host) && /(test|pipe)/i.test(database);
  return { ok, host, port, database, source };
}

let checked = false;

export function assertThrowawayDb(scriptName: string): void {
  if (checked) return;
  dotenv.config({ path: path.join(__dirname, '../../.env') }); // same file and no-override semantics as config/env.ts
  const t = evaluateDbTarget(process.env);
  console.log(`[db-guard] ${scriptName} → ${t.host}:${t.port}/${t.database} (from ${t.source})`);
  if (!t.ok) {
    console.error(
      `[db-guard] Refusing to run ${scriptName}: it writes to the database, and the target must be a LOCAL database ` +
      `whose name contains "test" or "pipe". Create a throwaway database and pass DATABASE_URL inline, e.g.\n` +
      `  DATABASE_URL=postgresql://postgres:<pw>@localhost:55433/askai_scratch_test <command>`
    );
    process.exit(2);
  }
  checked = true;
}
