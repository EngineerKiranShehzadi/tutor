/**
 * Unit tests for buildRequestLogRow (observability/request-log.service.ts).
 * No DB, no network — pure function tests, same manual-assertion convention
 * as the other test scripts.
 *
 * Usage: npm run test:request-log
 */
import { buildRequestLogRow } from '../observability/request-log.service';
import { ATTR } from '../observability/otel-semconv';
import type { FinishedSpan, FinishedTrace, SafeMetadata, SpanStatus } from '../observability/types';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } }
const cases: Case[] = [];

const TRACE_ID = 'a'.repeat(32);
const PRICING = {
  'model-a': { inputPer1M: 1, outputPer1M: 2 },
  'model-b': { inputPer1M: 0.5, outputPer1M: 4 },
};

let seq = 0;
function span(name: string, kind: string, durationMs: number, extra: Partial<FinishedSpan> = {}): FinishedSpan {
  return {
    spanId: `s${++seq}`, parentSpanId: 'root', name, kind: kind as FinishedSpan['kind'],
    startedAt: 0, durationMs, status: 'SUCCESS', metadata: {}, events: [], ...extra,
  };
}

function llm(model: string | undefined, input?: number, output?: number, extra: Partial<FinishedSpan> = {}): FinishedSpan {
  const metadata: SafeMetadata = {
    [ATTR.LLM_MODEL_NAME]: model,
    [ATTR.LLM_TOKEN_COUNT_PROMPT]: input,
    [ATTR.LLM_TOKEN_COUNT_COMPLETION]: output,
  };
  return span('some_call', 'LLM', 5, { metadata, ...extra });
}

function trace(spans: FinishedSpan[], attributes: SafeMetadata = {}, status: SpanStatus = 'SUCCESS', durationMs = 100): FinishedTrace {
  return { traceId: TRACE_ID, rootSpanId: 'root', rootName: 'ask-lecture-agent', startedAt: 0, durationMs, status, attributes, spans };
}

cases.push({
  label: 'Attributes map to route/status/ids/reasons and schema version',
  run: () => {
    const row = buildRequestLogRow(trace([], {
      lectureId: 7, sessionId: 12, studentId: 'stu-1', route: 'FACT_QUESTION',
      responseStatus: 'ANSWERED', notFoundReason: 'EMPTY_LECTURE', memoryResult: 'MISS',
      answerVerificationReason: 'GROUNDED', observabilitySchemaVersion: '2',
    }), true, PRICING);
    return row.traceId === TRACE_ID && row.lectureId === 7 && row.sessionId === 12 && row.studentId === 'stu-1' &&
      row.route === 'FACT_QUESTION' && row.status === 'SUCCESS' && row.responseStatus === 'ANSWERED' &&
      row.notFoundReason === 'EMPTY_LECTURE' && row.memoryResult === 'MISS' &&
      row.answerVerificationReason === 'GROUNDED' && row.schemaVersion === '2' && row.exportedToPhoenix === true;
  },
});

cases.push({
  label: "Missing/empty responseStatus becomes 'UNKNOWN' (never null)",
  run: () => {
    const a = buildRequestLogRow(trace([], {}), false, PRICING);
    const b = buildRequestLogRow(trace([], { responseStatus: '' }), false, PRICING);
    const c = buildRequestLogRow(trace([], { responseStatus: null }), false, PRICING);
    return a.responseStatus === 'UNKNOWN' && b.responseStatus === 'UNKNOWN' && c.responseStatus === 'UNKNOWN' &&
      a.route === null && a.exportedToPhoenix === false;
  },
});

cases.push({
  label: 'total_ms is the rounded trace duration',
  run: () => {
    return buildRequestLogRow(trace([], {}, 'SUCCESS', 1234.6), false, PRICING).totalMs === 1235 &&
      buildRequestLogRow(trace([], {}, 'SUCCESS', 0.4), false, PRICING).totalMs === 0;
  },
});

cases.push({
  label: 'stage_ms sums rounded durations per span name and excludes LLM spans',
  run: () => {
    const row = buildRequestLogRow(trace([
      span('vector-search', 'RETRIEVER', 10.4),
      span('vector-search', 'RETRIEVER', 20.6),
      span('generate-grounded-answer', 'CHAIN', 99.5),
      llm('model-a', 1, 1),
    ]), false, PRICING);
    const keys = Object.keys(row.stageMs).sort().join(',');
    return row.stageMs['vector-search'] === 31 && row.stageMs['generate-grounded-answer'] === 100 &&
      keys === 'generate-grounded-answer,vector-search';
  },
});

cases.push({
  label: 'llm_calls counts LLM spans; tokens are summed across them',
  run: () => {
    const row = buildRequestLogRow(trace([
      llm('model-a', 100, 10), llm('model-b', 200, 20), llm('model-a', 300, 30),
      span('vector-search', 'RETRIEVER', 5),
    ]), false, PRICING);
    return row.llmCalls === 3 && row.inputTokens === 600 && row.outputTokens === 60;
  },
});

cases.push({
  label: 'Tokens are null (not 0) when no LLM span reported any; llm_calls=0',
  run: () => {
    const none = buildRequestLogRow(trace([span('vector-search', 'RETRIEVER', 5)]), false, PRICING);
    const unreported = buildRequestLogRow(trace([llm('model-a')]), false, PRICING);
    return none.llmCalls === 0 && none.inputTokens === null && none.outputTokens === null && none.estCostUsd === null &&
      unreported.llmCalls === 1 && unreported.inputTokens === null && unreported.outputTokens === null;
  },
});

cases.push({
  label: 'Cost is tokens/1e6 * price, summed per LLM span by its own model',
  run: () => {
    // a: 1M in * 1 + 0.5M out * 2 = 2 ; b: 2M in * 0.5 + 0.25M out * 4 = 2
    const row = buildRequestLogRow(trace([
      llm('model-a', 1_000_000, 500_000), llm('model-b', 2_000_000, 250_000),
    ]), false, PRICING);
    return row.estCostUsd !== null && Math.abs(row.estCostUsd - 4) < 1e-9;
  },
});

cases.push({
  label: 'Unknown model -> est_cost_usd null (no guess)',
  run: () => {
    const row = buildRequestLogRow(trace([llm('model-zzz', 1000, 1000)]), false, PRICING);
    const noModel = buildRequestLogRow(trace([llm(undefined, 1000, 1000)]), false, PRICING);
    const empty = buildRequestLogRow(trace([llm('model-a', 1000, 1000)]), false, {});
    return row.estCostUsd === null && noModel.estCostUsd === null && empty.estCostUsd === null;
  },
});

cases.push({
  label: 'Partial pricing (one unpriced or token-less LLM span) -> null for the whole request',
  run: () => {
    const unknownMix = buildRequestLogRow(trace([llm('model-a', 1000, 1000), llm('model-zzz', 1000, 1000)]), false, PRICING);
    const missingTokens = buildRequestLogRow(trace([llm('model-a', 1000, 1000), llm('model-a', 1000, undefined)]), false, PRICING);
    return unknownMix.estCostUsd === null && missingTokens.estCostUsd === null;
  },
});

cases.push({
  label: 'Zero-priced model gives cost 0, not null',
  run: () => {
    const row = buildRequestLogRow(trace([llm('free', 1000, 1000)]), false, { free: { inputPer1M: 0, outputPer1M: 0 } });
    return row.estCostUsd === 0;
  },
});

cases.push({
  label: 'llm_model is the generate-grounded-answer child LLM span, else the last LLM span',
  run: () => {
    const answer = span('generate-grounded-answer', 'CHAIN', 50);
    const child = llm('model-b', 1, 1, { parentSpanId: answer.spanId });
    const withAnswer = buildRequestLogRow(trace([llm('model-a', 1, 1), answer, child, llm('model-a', 1, 1)]), false, PRICING);
    const withoutAnswer = buildRequestLogRow(trace([llm('model-a', 1, 1), llm('model-b', 1, 1)]), false, PRICING);
    const noLlm = buildRequestLogRow(trace([answer]), false, PRICING);
    return withAnswer.llmModel === 'model-b' && withoutAnswer.llmModel === 'model-b' && noLlm.llmModel === null;
  },
});

cases.push({
  label: 'ERROR trace carries the first span errorCode; SUCCESS trace has null error_code',
  run: () => {
    const err = buildRequestLogRow(trace([
      span('a', 'CHAIN', 1),
      span('vector-search', 'RETRIEVER', 1, { status: 'ERROR', errorCode: 'TIMEOUT' }),
      span('rerank-candidates', 'RERANKER', 1, { status: 'ERROR', errorCode: 'UNKNOWN_ERROR' }),
    ], { responseStatus: 'ERROR' }, 'ERROR'), false, PRICING);
    const ok = buildRequestLogRow(trace([span('a', 'CHAIN', 1, { errorCode: 'TIMEOUT' })]), false, PRICING);
    const errNoCode = buildRequestLogRow(trace([span('a', 'CHAIN', 1)], {}, 'ERROR'), false, PRICING);
    return err.status === 'ERROR' && err.errorCode === 'TIMEOUT' && err.responseStatus === 'ERROR' &&
      ok.errorCode === null && errNoCode.errorCode === null;
  },
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
