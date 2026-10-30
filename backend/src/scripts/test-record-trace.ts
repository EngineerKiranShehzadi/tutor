/**
 * Fail-open tests for recordTrace (observability/tracer.ts) and the
 * invalid-trace-id guard of writeRequestLog (observability/request-log.service.ts).
 * No DB, no network, no Phoenix, no LLM.
 *
 * recordTrace loads phoenix and request-log.service with dynamic import(),
 * which ts-node compiles to require(); the functions it calls are replaced on
 * those modules' exports objects. writeRequestLog's own DB access is stubbed
 * the same way on config/database's `query`.
 *
 * Usage: npm run test:record-trace
 */
import { env } from '../config/env';
import { recordTrace } from '../observability/tracer';
import type { FinishedTrace } from '../observability/types';
import type { RequestLogRow } from '../observability/request-log.service';

/* eslint-disable @typescript-eslint/no-var-requires */
const phoenix = require('../observability/phoenix') as { exportTraceToPhoenix: (t: FinishedTrace) => Promise<boolean> };
const requestLog = require('../observability/request-log.service') as {
  writeRequestLog: (row: RequestLogRow) => Promise<void>;
};
const database = require('../config/database') as { query: (text: string, params?: unknown[]) => Promise<unknown> };

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } | Promise<boolean | { pass: boolean; detail?: string }> }
const cases: Case[] = [];

const realExport = phoenix.exportTraceToPhoenix;
const realWrite = requestLog.writeRequestLog;
const realQuery = database.query;

function trace(traceId = 'a'.repeat(32)): FinishedTrace {
  return {
    traceId, rootSpanId: 'b'.repeat(16), rootName: 'ask-lecture-agent', startedAt: Date.now(), durationMs: 12,
    status: 'SUCCESS', attributes: { responseStatus: 'ANSWERED' }, spans: [],
  };
}

interface Calls { exports: number; writes: Array<{ traceId: string; exportedToPhoenix: unknown }> }

// Runs recordTrace with the given stubs and reports what happened.
async function scenario(opts: { exportThrows?: boolean; exportResult?: boolean; writeThrows?: boolean }): Promise<{ threw: boolean; calls: Calls }> {
  const calls: Calls = { exports: 0, writes: [] };
  phoenix.exportTraceToPhoenix = async () => {
    calls.exports++;
    if (opts.exportThrows) throw new Error('phoenix exploded');
    return opts.exportResult ?? true;
  };
  requestLog.writeRequestLog = async row => {
    calls.writes.push({ traceId: row.traceId, exportedToPhoenix: row.exportedToPhoenix });
    if (opts.writeThrows) throw new Error('db exploded');
  };
  try {
    await recordTrace(trace());
    return { threw: false, calls };
  } catch {
    return { threw: true, calls };
  } finally {
    phoenix.exportTraceToPhoenix = realExport;
    requestLog.writeRequestLog = realWrite;
  }
}

// ── recordTrace ───────────────────────────────────────────────────────────────

cases.push({
  label: 'recordTrace: happy path exports to Phoenix then writes one request-log row with exportedToPhoenix=true',
  run: async () => {
    const r = await scenario({});
    return !r.threw && r.calls.exports === 1 && r.calls.writes.length === 1 &&
      r.calls.writes[0].traceId === 'a'.repeat(32) && r.calls.writes[0].exportedToPhoenix === true;
  },
});

cases.push({
  label: 'recordTrace: Phoenix export returning false still writes the row with exportedToPhoenix=false',
  run: async () => {
    const r = await scenario({ exportResult: false });
    return !r.threw && r.calls.writes.length === 1 && r.calls.writes[0].exportedToPhoenix === false;
  },
});

cases.push({
  label: 'recordTrace never throws when the Phoenix export throws',
  run: async () => !(await scenario({ exportThrows: true })).threw,
});

cases.push({
  label: 'recordTrace never throws when writeRequestLog throws',
  run: async () => {
    const r = await scenario({ writeThrows: true });
    return !r.threw && r.calls.writes.length === 1;
  },
});

cases.push({
  label: 'recordTrace never throws when both the Phoenix export and writeRequestLog throw',
  run: async () => !(await scenario({ exportThrows: true, writeThrows: true })).threw,
});

cases.push({
  label: 'recordTrace still attempts the request-log write when the Phoenix export throws',
  run: async () => {
    const r = await scenario({ exportThrows: true });
    return r.calls.exports === 1 && r.calls.writes.length === 1 && r.calls.writes[0].traceId === 'a'.repeat(32);
  },
});

// ── writeRequestLog ───────────────────────────────────────────────────────────

const obs = env.OBSERVABILITY as unknown as { REQUEST_LOG_ENABLED: boolean };

async function writeWith(traceId: unknown, enabled = true): Promise<{ queries: number; threw: boolean }> {
  const prev = obs.REQUEST_LOG_ENABLED;
  obs.REQUEST_LOG_ENABLED = enabled;
  let queries = 0;
  database.query = async () => { queries++; return { rows: [], rowCount: 1 }; };
  // build a real row so every other field is valid; only the trace id varies
  const { buildRequestLogRow } = require('../observability/request-log.service') as typeof import('../observability/request-log.service');
  const row = { ...buildRequestLogRow(trace(), true, {}), traceId: traceId as string };
  try {
    await realWrite(row);
    return { queries, threw: false };
  } catch {
    return { queries, threw: true };
  } finally {
    database.query = realQuery;
    obs.REQUEST_LOG_ENABLED = prev;
  }
}

cases.push({
  label: 'writeRequestLog: a valid trace id reaches the DB layer exactly once (control)',
  run: async () => {
    const r = await writeWith('a'.repeat(32));
    return !r.threw && r.queries === 1;
  },
});

cases.push({
  label: 'writeRequestLog: invalid trace ids (all-zero, short, uppercase, UUID, empty, non-string) never touch the DB layer',
  run: async () => {
    const bad: unknown[] = ['0'.repeat(32), 'abc', 'A'.repeat(32), '123e4567-e89b-12d3-a456-426614174000', '', undefined, null, 42];
    for (const id of bad) {
      const r = await writeWith(id);
      if (r.threw || r.queries !== 0) return { pass: false, detail: `id=${String(id)} queries=${r.queries} threw=${r.threw}` };
    }
    return true;
  },
});

cases.push({
  label: 'writeRequestLog: REQUEST_LOG_ENABLED=false never touches the DB layer',
  run: async () => {
    const r = await writeWith('a'.repeat(32), false);
    return !r.threw && r.queries === 0;
  },
});

cases.push({
  label: 'writeRequestLog: a failing DB query is swallowed (does not throw)',
  run: async () => {
    const prev = obs.REQUEST_LOG_ENABLED;
    obs.REQUEST_LOG_ENABLED = true;
    database.query = async () => { throw new Error('connection refused'); };
    const { buildRequestLogRow } = require('../observability/request-log.service') as typeof import('../observability/request-log.service');
    try {
      await realWrite(buildRequestLogRow(trace(), true, {}));
      return true;
    } catch {
      return false;
    } finally {
      database.query = realQuery;
      obs.REQUEST_LOG_ENABLED = prev;
    }
  },
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      const pass = typeof r === 'boolean' ? r : r.pass;
      const detail = typeof r === 'boolean' ? '' : r.detail ? ` (${r.detail})` : '';
      if (pass) console.log(`PASS  ${c.label}${detail}`);
      else { failures++; console.log(`FAIL  ${c.label}${detail}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
