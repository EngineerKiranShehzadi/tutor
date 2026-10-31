/**
 * Unit tests for shouldExportTrace (observability/sampling.ts).
 * Pure: no DB, no network, no LLM — random() is injected.
 *
 * Usage: npm run test:sampling
 */
import { shouldExportTrace, decideTraceExport } from '../observability/sampling';
import type { FinishedTrace, SafeMetadata, SpanStatus } from '../observability/types';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } }
const cases: Case[] = [];

const SLOW_MS = 10000;
const never = () => 0.999999; // random() that loses any sampling draw
const always = () => 0;       // random() that wins any sampling draw

function trace(attributes: SafeMetadata = {}, status: SpanStatus = 'SUCCESS', durationMs = 100): FinishedTrace {
  return {
    traceId: 'a'.repeat(32), rootSpanId: 'root', rootName: 'ask-lecture-agent',
    startedAt: 0, durationMs, status, attributes, spans: [],
  };
}

const normal = (extra: SafeMetadata = {}) => ({ responseStatus: 'ANSWERED', ...extra });
const exp = (t: FinishedTrace, rate = 0, random = never) => shouldExportTrace(t, rate, random, SLOW_MS);

cases.push({
  label: 'status ERROR is always exported at sampleRate 0',
  run: () => exp(trace(normal(), 'ERROR')) === true && decideTraceExport(trace(normal(), 'ERROR'), 0, never, SLOW_MS).reason === 'error',
});

for (const rs of ['NOT_FOUND', 'REFUSED', 'ERROR', 'UNKNOWN', 'FALLBACK_ANSWER']) {
  cases.push({
    label: `responseStatus ${rs} is always exported at sampleRate 0`,
    run: () => exp(trace({ responseStatus: rs })) === true &&
      decideTraceExport(trace({ responseStatus: rs }), 0, never, SLOW_MS).reason === 'not_answered',
  });
}

cases.push({
  label: 'missing responseStatus counts as interesting',
  run: () => exp(trace({})) === true,
});

cases.push({
  label: 'answerVerificationReason other than VERIFIED is always exported',
  run: () => {
    const t = trace(normal({ answerVerificationReason: 'UNSUPPORTED_CLAIM' }));
    return exp(t) === true && decideTraceExport(t, 0, never, SLOW_MS).reason === 'verifier';
  },
});

cases.push({
  label: 'R6: answerVerificationReason VERIFICATION_DISABLED (verification switched off) does not force export',
  run: () => exp(trace(normal({ answerVerificationReason: 'VERIFICATION_DISABLED' }))) === false
    && decideTraceExport(trace(normal({ answerVerificationReason: 'VERIFICATION_DISABLED' })), 1, never, SLOW_MS).reason === 'sampled',
});

cases.push({
  label: 'answerVerificationReason VERIFIED / unset does not force export',
  run: () => exp(trace(normal({ answerVerificationReason: 'VERIFIED' }))) === false &&
    exp(trace(normal())) === false &&
    exp(trace(normal({ answerVerificationReason: null }))) === false,
});

cases.push({
  label: 'durationMs above the slow threshold is always exported; at the threshold it is not',
  run: () => {
    const slow = trace(normal(), 'SUCCESS', SLOW_MS + 1);
    return exp(slow) === true && decideTraceExport(slow, 0, never, SLOW_MS).reason === 'slow' &&
      exp(trace(normal(), 'SUCCESS', SLOW_MS)) === false;
  },
});

for (const rs of ['ANSWERED', 'MEMORY_HIT_ANSWERED', 'GREETING_ANSWERED', 'SUMMARY_ANSWERED']) {
  cases.push({
    label: `normal ${rs} trace follows the injected random() at sampleRate 0.5`,
    run: () => exp(trace({ responseStatus: rs }), 0.5, () => 0.49) === true &&
      exp(trace({ responseStatus: rs }), 0.5, () => 0.5) === false,
  });
}

cases.push({
  label: 'sampleRate 1 always exports a normal trace, even with the worst random()',
  run: () => exp(trace(normal()), 1, never) === true,
});

cases.push({
  label: 'sampleRate 0 drops a normal fast answered trace, even with the best random()',
  run: () => exp(trace(normal()), 0, always) === false &&
    decideTraceExport(trace(normal()), 0, always, SLOW_MS).reason === 'dropped',
});

cases.push({
  label: 'sampled decision reports reason "sampled"',
  run: () => decideTraceExport(trace(normal()), 1, never, SLOW_MS).reason === 'sampled',
});

function main() {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = c.run();
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

main();
