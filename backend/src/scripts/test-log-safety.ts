/**
 * Tests for log safety: logSafeText (observability/sanitize.ts) and the
 * traceId stamp the logger (utils/logger.ts) adds inside an active trace.
 * No DB, no network, no LLM, no files — log records are captured with an
 * in-memory winston transport.
 *
 * Usage: npm run test:log-safety
 */
import Transport from 'winston-transport';
import { createHash } from 'crypto';
import { env } from '../config/env';
import { logSafeText } from '../observability/sanitize';
import { RequestTrace } from '../observability/tracer';
import { logger } from '../utils/logger';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } | Promise<boolean | { pass: boolean; detail?: string }> }
const cases: Case[] = [];

const obs = env.OBSERVABILITY as unknown as { CAPTURE_CONTENT: boolean };
const withCapture = <T>(on: boolean, fn: () => T): T => {
  const prev = obs.CAPTURE_CONTENT;
  obs.CAPTURE_CONTENT = on;
  try { return fn(); } finally { obs.CAPTURE_CONTENT = prev; }
};

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

// ── logSafeText ───────────────────────────────────────────────────────────────

const SECRET = 'What is the secret exam answer for student 4242?';

cases.push({
  label: 'capture off: logSafeText returns "[len=N sha=<8 hex>]" and never the input',
  run: () => withCapture(false, () => {
    const out = logSafeText(SECRET);
    return out === `[len=${SECRET.length} sha=${sha8(SECRET)}]` && /^\[len=\d+ sha=[0-9a-f]{8}\]$/.test(out) &&
      !out.includes(SECRET) && !out.includes('secret') && !out.includes('4242');
  }),
});

cases.push({
  label: 'capture off: no fragment of a long input leaks, whatever maxLength is passed',
  run: () => withCapture(false, () => {
    const long = 'confidential-'.repeat(50);
    const a = logSafeText(long);
    const b = logSafeText(long, 5);
    const c = logSafeText(long, 100000);
    return [a, b, c].every(o => !o.includes('confidential') && o === `[len=${long.length} sha=${sha8(long)}]`);
  }),
});

cases.push({
  label: 'capture off: same text -> same digest, different text -> different digest; null/undefined/empty are safe',
  run: () => withCapture(false, () => {
    return logSafeText('abc') === logSafeText('abc') && logSafeText('abc') !== logSafeText('abd') &&
      logSafeText('') === `[len=0 sha=${sha8('')}]` &&
      logSafeText(undefined as unknown as string) === `[len=0 sha=${sha8('')}]` &&
      logSafeText(null as unknown as string) === `[len=0 sha=${sha8('')}]`;
  }),
});

cases.push({
  label: 'capture on: logSafeText returns the text, unchanged when within maxLength',
  run: () => withCapture(true, () => logSafeText(SECRET) === SECRET && logSafeText('short', 5) === 'short'),
});

cases.push({
  label: 'capture on: text longer than maxLength is truncated (default 80) with the truncation marker',
  run: () => withCapture(true, () => {
    const long = 'x'.repeat(200);
    const def = logSafeText(long);
    const small = logSafeText(long, 10);
    return def.startsWith('x'.repeat(80)) && !def.startsWith('x'.repeat(81)) && def.endsWith('…[truncated]') &&
      small === 'x'.repeat(10) + '…[truncated]';
  }),
});

// ── Logger traceId stamp ──────────────────────────────────────────────────────

class MemoryTransport extends Transport {
  readonly records: Array<Record<string, unknown>> = [];
  log(info: Record<string, unknown>, next: () => void): void {
    this.records.push({ ...info });
    next();
  }
}

const memory = new MemoryTransport();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const find = (marker: string) => memory.records.find(r => r.message === marker);

cases.push({
  label: 'logger stamps traceId inside runAsActive (also after awaits and inside nested spans)',
  run: async () => {
    const t = new RequestTrace('ask-lecture-agent');
    await t.runAsActive(async () => {
      logger.info('marker-in-root');
      await new Promise(r => setTimeout(r, 1));
      logger.info('marker-after-await');
      await t.span('vector-search', async () => {
        await Promise.resolve();
        logger.warn('marker-in-span');
      });
    });
    await flush();
    return ['marker-in-root', 'marker-after-await', 'marker-in-span'].every(m => find(m)?.traceId === t.traceId);
  },
});

cases.push({
  label: 'logger adds no traceId outside any trace (before and after a trace ran)',
  run: async () => {
    logger.info('marker-before');
    const t = new RequestTrace('ask-lecture-agent');
    await t.runAsActive(async () => { logger.info('marker-inside'); });
    logger.info('marker-after');
    await flush();
    const before = find('marker-before');
    const after = find('marker-after');
    return !!before && !!after && !('traceId' in before) && !('traceId' in after) && !!find('marker-inside')?.traceId;
  },
});

cases.push({
  label: 'concurrent traces never see each other\'s traceId',
  run: async () => {
    const a = new RequestTrace('a');
    const b = new RequestTrace('b');
    const work = (t: RequestTrace, tag: string) => t.runAsActive(async () => {
      await new Promise(r => setTimeout(r, tag === 'A' ? 5 : 1));
      logger.info(`marker-concurrent-${tag}`);
    });
    await Promise.all([work(a, 'A'), work(b, 'B')]);
    await flush();
    return a.traceId !== b.traceId && find('marker-concurrent-A')?.traceId === a.traceId &&
      find('marker-concurrent-B')?.traceId === b.traceId;
  },
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  logger.add(memory);
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
