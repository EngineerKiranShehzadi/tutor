/**
 * Unit tests for the pure helpers in services/observability/monitor.service.ts.
 * No DB queries, no network — same manual-assertion convention as the other
 * test scripts.
 *
 * Usage: npm run test:monitor
 */
import { parseWindow, bucketUnit, buildReasons, rate } from '../services/observability/monitor.service';

interface Case { label: string; run: () => boolean }
const cases: Case[] = [];
const SLOW = 10_000;
const ok = { status: 'SUCCESS', responseStatus: 'ANSWERED', answerVerificationReason: 'VERIFIED', totalMs: 500 };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// window parsing
for (const w of ['24h', '7d', '30d'] as const) {
  cases.push({ label: `parseWindow("${w}") -> ${w}`, run: () => parseWindow(w) === w });
}
cases.push({ label: 'parseWindow(undefined) defaults to 24h', run: () => parseWindow(undefined) === '24h' });
cases.push({ label: 'parseWindow("") defaults to 24h', run: () => parseWindow('') === '24h' });
cases.push({ label: 'parseWindow("1y") falls back to 24h', run: () => parseWindow('1y') === '24h' });
cases.push({ label: 'parseWindow(7) (non-string) falls back to 24h', run: () => parseWindow(7) === '24h' });

// bucket size
cases.push({ label: 'bucketUnit 24h -> hour', run: () => bucketUnit('24h') === 'hour' });
cases.push({ label: 'bucketUnit 7d -> hour', run: () => bucketUnit('7d') === 'hour' });
cases.push({ label: 'bucketUnit 30d -> day', run: () => bucketUnit('30d') === 'day' });

// reasons
cases.push({ label: 'healthy fast request has no reasons', run: () => same(buildReasons(ok, SLOW), []) });
cases.push({ label: 'status ERROR -> ["error"]', run: () => same(buildReasons({ ...ok, status: 'ERROR' }, SLOW), ['error']) });
cases.push({ label: 'NOT_FOUND -> ["not_answered"]', run: () => same(buildReasons({ ...ok, responseStatus: 'NOT_FOUND' }, SLOW), ['not_answered']) });
cases.push({ label: 'GUARDRAIL_REJECTED -> ["not_answered"]', run: () => same(buildReasons({ ...ok, responseStatus: 'GUARDRAIL_REJECTED' }, SLOW), ['not_answered']) });
for (const rs of ['ANSWERED', 'MEMORY_HIT_ANSWERED', 'GREETING_ANSWERED', 'SUMMARY_ANSWERED']) {
  cases.push({ label: `${rs} is not "not_answered"`, run: () => same(buildReasons({ ...ok, responseStatus: rs }, SLOW), []) });
}
cases.push({ label: 'verification reason other than VERIFIED -> ["verifier"]', run: () => same(buildReasons({ ...ok, answerVerificationReason: 'UNSUPPORTED_CLAIMS' }, SLOW), ['verifier']) });
cases.push({ label: 'NULL verification reason -> no "verifier"', run: () => same(buildReasons({ ...ok, answerVerificationReason: null }, SLOW), []) });
cases.push({ label: 'totalMs above threshold -> ["slow"]', run: () => same(buildReasons({ ...ok, totalMs: SLOW + 1 }, SLOW), ['slow']) });
cases.push({ label: 'totalMs equal to threshold is not slow', run: () => same(buildReasons({ ...ok, totalMs: SLOW }, SLOW), []) });
cases.push({
  label: 'multiple problems keep order error, not_answered, verifier, slow',
  run: () => same(buildReasons({ status: 'ERROR', responseStatus: 'NOT_FOUND', answerVerificationReason: 'REVISE', totalMs: SLOW + 1 }, SLOW),
    ['error', 'not_answered', 'verifier', 'slow']),
});

// rates
cases.push({ label: 'rate(5, 0) is null, not NaN/0', run: () => rate(5, 0) === null });
cases.push({ label: 'rate(0, 0) is null', run: () => rate(0, 0) === null });
cases.push({ label: 'rate(0, 10) is 0', run: () => rate(0, 10) === 0 });
cases.push({ label: 'rate(1, 4) is 0.25', run: () => rate(1, 4) === 0.25 });
cases.push({ label: 'rate accepts numeric strings from pg ("3", 4) -> 0.75', run: () => rate('3', 4) === 0.75 });

function main() {
  let failures = 0;
  for (const c of cases) {
    try {
      if (c.run()) console.log(`PASS  ${c.label}`);
      else { failures++; console.log(`FAIL  ${c.label}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
