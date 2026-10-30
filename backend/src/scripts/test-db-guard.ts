/**
 * Unit checks for the shared throwaway-database guard (test-db-guard-lib.ts).
 * Pure: no database, no network.
 *
 * Usage: npm run test:db-guard
 */
import { evaluateDbTarget } from './test-db-guard-lib';

interface Case { label: string; run: () => boolean }
const cases: Case[] = [];
const ev = (e: Record<string, string>) => evaluateDbTarget(e as NodeJS.ProcessEnv);

cases.push({ label: 'refuses the dev database (DATABASE_URL)', run: () =>
  !ev({ DATABASE_URL: 'postgresql://postgres:pw@localhost:55433/askaitutor_dev' }).ok });
cases.push({ label: 'accepts a local throwaway DB (DATABASE_URL, name has "test")', run: () => {
  const t = ev({ DATABASE_URL: 'postgresql://postgres:pw@localhost:55433/askai_x_test' });
  return t.ok && t.host === 'localhost' && t.port === '55433' && t.database === 'askai_x_test';
} });
cases.push({ label: 'accepts a local DB whose name contains "pipe"', run: () =>
  ev({ DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:55432/askai_pipe' }).ok });
cases.push({ label: 'refuses a remote host even if the name says test', run: () =>
  !ev({ DATABASE_URL: 'postgresql://u:pw@ep-x.neon.tech/neondb_test' }).ok });
cases.push({ label: 'a "test" in the host or password does not count — only the database name', run: () =>
  !ev({ DATABASE_URL: 'postgresql://postgres:test@localhost:55433/askaitutor_dev' }).ok
  && !ev({ DATABASE_URL: 'postgresql://postgres:pw@localhost:55433/askaitutor_dev?application_name=test' }).ok });
cases.push({ label: 'no DATABASE_URL: falls back to DB_HOST/DB_PORT/DB_NAME exactly as config/database does', run: () =>
  !ev({ DB_HOST: 'localhost', DB_PORT: '55433', DB_NAME: 'askaitutor_dev' }).ok
  && ev({ DB_HOST: 'localhost', DB_PORT: '55433', DB_NAME: 'askai_x_test' }).ok
  && !ev({}).ok /* defaults to localhost:5432/askaitutor */ });
cases.push({ label: 'DATABASE_URL wins over DB_NAME (the pool ignores DB_NAME when a URL is set)', run: () =>
  !ev({ DATABASE_URL: 'postgresql://p:pw@localhost:1/askaitutor_dev', DB_NAME: 'askai_x_test' }).ok
  && ev({ DATABASE_URL: 'postgresql://p:pw@localhost:1/askai_x_test', DB_NAME: 'askaitutor_dev' }).ok });
cases.push({ label: 'the report never contains the password', run: () => {
  const t = ev({ DATABASE_URL: 'postgresql://postgres:s3cretpw@localhost:55433/askaitutor_dev' });
  return !JSON.stringify(t).includes('s3cretpw');
} });
cases.push({ label: 'unparseable DATABASE_URL is refused', run: () => !ev({ DATABASE_URL: 'not a url' }).ok });

let failures = 0;
for (const c of cases) {
  let pass = false;
  try { pass = c.run(); } catch (err) { console.log(`      threw: ${(err as Error).message}`); }
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures > 0 ? 1 : 0);
