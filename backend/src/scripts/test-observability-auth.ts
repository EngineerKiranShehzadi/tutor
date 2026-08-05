/**
 * HTTP-level authorization tests for /api/v1/observability/* routes.
 *
 * No new test framework/dependency: boots the real Express app
 * (createApp(), same as server.ts) on an ephemeral port and drives it
 * with Node 20's built-in global fetch — same manual-assertion
 * convention as every other test script in this project (see
 * test-observability.ts). Tokens are minted directly via
 * generateAccessToken() against real ADMIN/STUDENT rows already in the
 * dev DB, avoiding any dependency on the login flow or stored passwords.
 *
 * Covers: unauthenticated -> 401, invalid token -> 401, authenticated
 * non-admin -> 403, authenticated admin -> 200, and that a write endpoint
 * cannot be reached by a non-admin (still 403, never touches Phoenix).
 *
 * Usage: npm run test:observability-auth
 */
import { createApp } from '../app';
import { query } from '../config/database';
import { generateAccessToken } from '../utils/jwt';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: (base: string) => Promise<CaseResult> }
const cases: Case[] = [];

cases.push({
  label: 'GET /observability/status with no Authorization header -> 401',
  run: async (base) => {
    const res = await fetch(`${base}/api/v1/observability/status`);
    const body = await res.json().catch(() => ({}));
    return { pass: res.status === 401, detail: `status=${res.status} body=${JSON.stringify(body).slice(0, 150)}` };
  },
});

cases.push({
  label: 'GET /observability/status with a malformed/invalid token -> 401',
  run: async (base) => {
    const res = await fetch(`${base}/api/v1/observability/status`, {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    return { pass: res.status === 401, detail: `status=${res.status}` };
  },
});

cases.push({
  label: 'GET /observability/status as an authenticated STUDENT (non-admin) -> 403',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'STUDENT' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no STUDENT user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'STUDENT');
    const res = await fetch(`${base}/api/v1/observability/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { pass: res.status === 403, detail: `status=${res.status}` };
  },
});

cases.push({
  label: 'POST /observability/traces/:id/notes as a STUDENT (non-admin) -> 403, never reaches the handler',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'STUDENT' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no STUDENT user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'STUDENT');
    const res = await fetch(`${base}/api/v1/observability/traces/fake-trace-id/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'should never be written' }),
    });
    return { pass: res.status === 403, detail: `status=${res.status}` };
  },
});

cases.push({
  label: 'GET /observability/status as an authenticated ADMIN -> 200 with expected shape',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no ADMIN user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'ADMIN');
    const res = await fetch(`${base}/api/v1/observability/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({})) as { success?: boolean; data?: { observabilityEnabled?: unknown } };
    const pass = res.status === 200 && body.success === true && typeof body.data?.observabilityEnabled === 'boolean';
    return { pass, detail: `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}` };
  },
});

cases.push({
  label: 'GET /observability/capabilities as an authenticated ADMIN -> 200 (does not throw even if Phoenix is unreachable)',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no ADMIN user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'ADMIN');
    const res = await fetch(`${base}/api/v1/observability/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({})) as { success?: boolean };
    return { pass: res.status === 200 && body.success === true, detail: `status=${res.status}` };
  },
});

cases.push({
  label: 'GET /observability/traces with an invalid limit (non-numeric) -> clean 422, not 500/stack trace',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no ADMIN user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'ADMIN');
    const res = await fetch(`${base}/api/v1/observability/traces?limit=not-a-number`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    // This route's validation middleware (middleware/validate.ts) responds
    // 422 Unprocessable Entity for express-validator failures, not 400 —
    // the important assertion is "clean structured 4xx, no stack trace",
    // not the exact code.
    return { pass: res.status === 422 && !JSON.stringify(body).match(/\bat\s+\w+.*\(.*:\d+:\d+\)/), detail: `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}` };
  },
});

cases.push({
  label: 'GET /observability/metrics/constructor cannot bypass the slice allowlist to leak the full metrics payload',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no ADMIN user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'ADMIN');
    const res = await fetch(`${base}/api/v1/observability/metrics/constructor`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    return { pass: res.status === 404, detail: `status=${res.status} body=${JSON.stringify(body).slice(0, 150)}` };
  },
});

cases.push({
  label: 'GET /observability/traces?spanKind=NOT_A_REAL_KIND is rejected, not silently no-op filtered',
  run: async (base) => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!rows[0]) return { pass: false, detail: 'SKIPPED — no ADMIN user in DB to test with' };
    const token = generateAccessToken(rows[0].id, 'ADMIN');
    const res = await fetch(`${base}/api/v1/observability/traces?spanKind=NOT_A_REAL_KIND`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { pass: res.status === 422, detail: `status=${res.status}` };
  },
});

async function main() {
  const app = await createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind ephemeral port');
  const base = `http://127.0.0.1:${addr.port}`;

  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run(base);
      if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }

  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  // server.close()'s callback waits for every open connection (including
  // fetch's keep-alive sockets) to drain, which can hang or race with
  // process.exit() depending on undici's socket-pool timing — irrelevant
  // for a one-shot test script, so force-close immediately rather than
  // waiting for a graceful drain that has no purpose here.
  server.closeAllConnections?.();
  server.close();
  process.exit(failures > 0 ? 1 : 0);
}

main();
