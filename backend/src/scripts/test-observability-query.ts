/**
 * Unit tests for the Phoenix query/normalization layer
 * (services/observability/normalize.ts): Phoenix-shaped span -> our
 * ObservabilitySpan mapping, tree building with malformed data, timeline/
 * critical-path derivation, and trace-summary extraction. All inputs here
 * are synthetic, Phoenix-response-shaped fixtures — no real Phoenix server
 * required, matching the spec's "mock Phoenix at the HTTP/client boundary"
 * requirement for the ordinary unit-test suite.
 *
 * Usage: npm run test:observability-query
 */
import {
  mapPhoenixSpan, buildSpanTree, buildTimeline, buildCriticalPath, depthMapFromTree, extractTraceSummary,
  type RawPhoenixSpan,
} from '../services/observability/normalize';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } }
const cases: Case[] = [];

function rawSpan(overrides: Partial<RawPhoenixSpan> & { span_id: string; parent_id?: string | null }): RawPhoenixSpan {
  return {
    name: 'span',
    context: { trace_id: 'trace-1', span_id: overrides.span_id },
    span_kind: 'CHAIN',
    parent_id: overrides.parent_id ?? null,
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:00.100Z',
    status_code: 'OK',
    attributes: {},
    events: [],
    ...overrides,
  };
}

cases.push({
  label: 'mapPhoenixSpan extracts model/tokens/kind from OpenInference attributes',
  run: () => {
    const span = mapPhoenixSpan(rawSpan({
      span_id: 's1',
      name: 'gemini_answer_call',
      attributes: {
        'openinference.span.kind': 'LLM',
        'llm.model_name': 'gemini-2.5-flash',
        'llm.token_count.prompt': 120,
        'llm.token_count.completion': 40,
      },
    }));
    const pass = span.kind === 'LLM' && span.model === 'gemini-2.5-flash' && span.tokens?.prompt === 120 && span.tokens?.completion === 40 && span.tokens?.total === 160;
    return { pass, detail: JSON.stringify({ kind: span.kind, model: span.model, tokens: span.tokens, attrs: span.attributes }) };
  },
});

cases.push({
  label: 'mapPhoenixSpan redacts a secret-shaped attribute value',
  run: () => {
    const span = mapPhoenixSpan(rawSpan({ span_id: 's2', attributes: { apiKey: 'sk-should-not-leak-1234567890' } }));
    return span.attributes.apiKey === '[REDACTED]';
  },
});

cases.push({
  label: 'mapPhoenixSpan handles the minimal embedded TraceSpanData shape (no context/attributes/events) without throwing',
  run: () => {
    // Regression test: getTraces({ includeSpans: true })'s embedded spans
    // are the client's TraceSpanData schema, verified against
    // @arizeai/phoenix-client's generated OpenAPI types AND a live
    // Phoenix 19.13.0 server — genuinely flat span_id (no nested
    // `context`), no `attributes`, no `events` at all. This is a
    // materially different, more minimal shape than getSpans()'s
    // OTel-native Span schema (which nests ids under `context`). Passing
    // this shape through unchanged used to throw
    // "Cannot read properties of undefined (reading 'span_id')" on the
    // very first real trace-list request against a live server.
    const minimal = {
      name: 'ask-lecture-agent',
      span_id: 'flat-span-id',
      parent_id: null,
      span_kind: 'CHAIN',
      status_code: 'OK',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:00.100Z',
      // no `context`, `attributes`, or `events` — matches the real
      // TraceSpanData schema exactly, not a synthetic edge case.
    };
    const span = mapPhoenixSpan(minimal, 'fallback-trace-id');
    return {
      pass: span.spanId === 'flat-span-id' && span.traceId === 'fallback-trace-id' && span.kind === 'CHAIN' && span.attributes && span.events.length === 0,
      detail: JSON.stringify({ spanId: span.spanId, traceId: span.traceId, kind: span.kind }),
    };
  },
});

cases.push({
  label: 'buildSpanTree nests real parent/child relationships at arbitrary depth',
  run: () => {
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'a', parent_id: 'root' })),
      mapPhoenixSpan(rawSpan({ span_id: 'b', parent_id: 'a' })),
      mapPhoenixSpan(rawSpan({ span_id: 'c', parent_id: 'b' })),
    ];
    const tree = buildSpanTree(spans, 'root', 100);
    const pass = tree.length === 1 && tree[0].spanId === 'a' && tree[0].children[0]?.spanId === 'b' && tree[0].children[0]?.children[0]?.spanId === 'c'
      && tree[0].depth === 0 && tree[0].children[0].depth === 1 && tree[0].children[0].children[0].depth === 2;
    return { pass, detail: JSON.stringify(tree.map(n => n.spanId)) };
  },
});

cases.push({
  label: 'buildSpanTree attaches a span with an unknown parentId to the top level (orphan handling)',
  run: () => {
    const spans = [mapPhoenixSpan(rawSpan({ span_id: 'orphan', parent_id: 'does-not-exist' }))];
    const tree = buildSpanTree(spans, 'root', 100);
    return tree.length === 1 && tree[0].spanId === 'orphan';
  },
});

cases.push({
  label: 'buildSpanTree does not infinitely recurse on a cycle (terminates fast, never throws)',
  run: () => {
    // x and y each claim the other as parent, and neither points at root —
    // a pure 2-node cycle disconnected from root. The tree-walk's
    // `visiting` guard must stop it from hanging/stack-overflowing; since
    // neither node resolves to root, they legitimately do not appear in
    // the rendered top-level tree (the correctness bar here is "does not
    // hang or crash", not "silently-cyclic data must still render").
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'x', parent_id: 'y' })),
      mapPhoenixSpan(rawSpan({ span_id: 'y', parent_id: 'x' })),
    ];
    const start = Date.now();
    buildSpanTree(spans, 'root', 100);
    return Date.now() - start < 2000;
  },
});

cases.push({
  label: 'buildSpanTree keeps only the first occurrence of a duplicate spanId',
  run: () => {
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'dup', parent_id: 'root', name: 'first' })),
      mapPhoenixSpan(rawSpan({ span_id: 'dup', parent_id: 'root', name: 'second' })),
    ];
    const tree = buildSpanTree(spans, 'root', 100);
    return tree.length === 1 && tree[0].name === 'first';
  },
});

cases.push({
  label: 'buildTimeline computes offsetMs relative to trace start, sorted chronologically',
  run: () => {
    const traceStart = new Date('2026-01-01T00:00:00.000Z').getTime();
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'later', start_time: '2026-01-01T00:00:00.500Z', end_time: '2026-01-01T00:00:00.600Z' })),
      mapPhoenixSpan(rawSpan({ span_id: 'earlier', start_time: '2026-01-01T00:00:00.100Z', end_time: '2026-01-01T00:00:00.200Z' })),
    ];
    const timeline = buildTimeline(spans, traceStart, 1000, new Map());
    return timeline[0].spanId === 'earlier' && timeline[0].offsetMs === 100 && timeline[1].spanId === 'later' && timeline[1].offsetMs === 500;
  },
});

cases.push({
  label: 'buildCriticalPath follows the longest-duration child at each level',
  run: () => {
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'fast', parent_id: 'root', end_time: '2026-01-01T00:00:00.010Z' })),
      mapPhoenixSpan(rawSpan({ span_id: 'slow', parent_id: 'root', end_time: '2026-01-01T00:00:00.900Z' })),
      mapPhoenixSpan(rawSpan({ span_id: 'slow-child', parent_id: 'slow', end_time: '2026-01-01T00:00:00.800Z' })),
    ];
    const tree = buildSpanTree(spans, 'root', 900);
    const path = buildCriticalPath(tree);
    return path.length === 2 && path[0].spanId === 'slow' && path[1].spanId === 'slow-child';
  },
});

cases.push({
  label: 'depthMapFromTree matches the depths assigned during tree construction',
  run: () => {
    const spans = [
      mapPhoenixSpan(rawSpan({ span_id: 'a', parent_id: 'root' })),
      mapPhoenixSpan(rawSpan({ span_id: 'b', parent_id: 'a' })),
    ];
    const tree = buildSpanTree(spans, 'root', 100);
    const depths = depthMapFromTree(tree);
    return depths.get('a') === 0 && depths.get('b') === 1;
  },
});

cases.push({
  label: 'extractTraceSummary reads route/memory/lecture attributes set by chat.service.ts',
  run: () => {
    const root = mapPhoenixSpan(rawSpan({
      span_id: 'root', name: 'ask-lecture-agent',
      attributes: { route: 'FACT_QUESTION', memoryResult: 'MISS', lectureId: '42', sessionId: '7', studentId: 'stu-1', candidateCount: 3, selectedChunkCount: 2 },
    }));
    const summary = extractTraceSummary('trace-1', root, [root]);
    return summary.route === 'FACT_QUESTION' && summary.memoryResult === 'MISS' && summary.lectureId === '42' && summary.sessionId === '7' && summary.userId === 'stu-1' && summary.retrievalCount === 3 && summary.selectedChunkCount === 2;
  },
});

cases.push({
  label: 'extractTraceSummary sums cumulative tokens across multiple LLM spans when no override is given',
  run: () => {
    const root = mapPhoenixSpan(rawSpan({ span_id: 'root', name: 'ask-lecture-agent' }));
    const llm1 = mapPhoenixSpan(rawSpan({ span_id: 'llm1', parent_id: 'root', attributes: { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 10, 'llm.token_count.completion': 5 } }));
    const llm2 = mapPhoenixSpan(rawSpan({ span_id: 'llm2', parent_id: 'root', attributes: { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 20, 'llm.token_count.completion': 10 } }));
    const summary = extractTraceSummary('trace-1', root, [root, llm1, llm2]);
    return summary.promptTokens === 30 && summary.completionTokens === 15;
  },
});

cases.push({
  label: 'extractTraceSummary does not leak question/answer text when content capture is off',
  run: () => {
    const root = mapPhoenixSpan(rawSpan({ span_id: 'root', attributes: { 'input.value': 'a secret student question' } }));
    const summary = extractTraceSummary('trace-1', root, [root]);
    // OBSERVABILITY_CAPTURE_CONTENT defaults to false in this test process env.
    return summary.questionPreview === null;
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
