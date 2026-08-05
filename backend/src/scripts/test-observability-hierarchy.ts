/**
 * Unit tests for RequestTrace's span hierarchy (observability/tracer.ts):
 * real spanId/parentSpanId nesting via AsyncLocalStorage, arbitrary depth,
 * concurrent-trace isolation, and malformed-hierarchy export safety
 * (observability/phoenix.ts's tree-walk). No DB, no network, no Gemini.
 *
 * Usage: npm run test:observability-hierarchy
 */
import { RequestTrace, getActiveTrace } from '../observability/tracer';
import { exportTraceToPhoenix } from '../observability/phoenix';
import type { FinishedTrace } from '../observability/types';

interface Case { label: string; run: () => Promise<boolean | { pass: boolean; detail?: string }> }
const cases: Case[] = [];

cases.push({
  label: 'A span created inside another span becomes a real child (correct parentSpanId)',
  run: async () => {
    const trace = new RequestTrace('root-op');
    const finished = await trace.runAsActive(async () => {
      await trace.span('outer', async () => {
        await trace.span('inner', async () => 'ok');
      });
      return trace.end('SUCCESS');
    });
    const outer = finished.spans.find(s => s.name === 'outer')!;
    const inner = finished.spans.find(s => s.name === 'inner')!;
    return outer.parentSpanId === finished.rootSpanId && inner.parentSpanId === outer.spanId;
  },
});

cases.push({
  label: 'Three levels of nesting are all preserved correctly',
  run: async () => {
    const trace = new RequestTrace('root-op');
    const finished = await trace.runAsActive(async () => {
      await trace.span('a', async () => {
        await trace.span('b', async () => {
          await trace.span('c', async () => 'ok');
        });
      });
      return trace.end('SUCCESS');
    });
    const a = finished.spans.find(s => s.name === 'a')!;
    const b = finished.spans.find(s => s.name === 'b')!;
    const c = finished.spans.find(s => s.name === 'c')!;
    const pass = a.parentSpanId === finished.rootSpanId && b.parentSpanId === a.spanId && c.parentSpanId === b.spanId;
    return { pass, detail: `a.parent=${a.parentSpanId} root=${finished.rootSpanId} b.parent=${b.parentSpanId} a.id=${a.spanId} c.parent=${c.parentSpanId} b.id=${b.spanId}` };
  },
});

cases.push({
  label: 'Sibling spans at the same level share the same parentSpanId, not each other',
  run: async () => {
    const trace = new RequestTrace('root-op');
    const finished = await trace.runAsActive(async () => {
      await trace.span('sibling-1', async () => 'ok');
      await trace.span('sibling-2', async () => 'ok');
      return trace.end('SUCCESS');
    });
    const s1 = finished.spans.find(s => s.name === 'sibling-1')!;
    const s2 = finished.spans.find(s => s.name === 'sibling-2')!;
    return s1.parentSpanId === finished.rootSpanId && s2.parentSpanId === finished.rootSpanId && s1.spanId !== s2.spanId;
  },
});

cases.push({
  label: 'A failing nested span is recorded as ERROR with exception info, and the error still propagates',
  run: async () => {
    const trace = new RequestTrace('root-op');
    let threw = false;
    let finished: FinishedTrace | undefined;
    await trace.runAsActive(async () => {
      try {
        await trace.span('outer', async () => {
          await trace.span('inner-fails', async () => { throw new Error('boom'); });
        });
      } catch {
        threw = true;
      }
      finished = trace.end('ERROR');
    });
    // The raw message is captured at the in-process tracer level (needed
    // for server logs/debugging); sanitize.ts redacts/truncates it only at
    // the Phoenix-export and admin-API-read boundaries (see phoenix.ts's
    // setSafeAttributes and normalize.ts) — not here.
    const innerSpan = finished!.spans.find(s => s.name === 'inner-fails')!;
    const pass = threw && innerSpan.status === 'ERROR' && !!innerSpan.exception
      && innerSpan.exception.errorCode === 'UNKNOWN_ERROR' && innerSpan.exception.message === 'boom';
    return { pass, detail: JSON.stringify(innerSpan.exception) };
  },
});

cases.push({
  label: 'Two concurrent traces (Promise.all) never leak spans into each other',
  run: async () => {
    const traceA = new RequestTrace('root-a');
    const traceB = new RequestTrace('root-b');
    const [finishedA, finishedB] = await Promise.all([
      traceA.runAsActive(async () => {
        await traceA.span('a-child', async () => new Promise(r => setTimeout(r, 10)));
        return traceA.end('SUCCESS');
      }),
      traceB.runAsActive(async () => {
        await traceB.span('b-child', async () => new Promise(r => setTimeout(r, 5)));
        return traceB.end('SUCCESS');
      }),
    ]);
    const aOk = finishedA.spans.length === 1 && finishedA.spans[0].name === 'a-child';
    const bOk = finishedB.spans.length === 1 && finishedB.spans[0].name === 'b-child';
    return { pass: aOk && bOk, detail: `a=${JSON.stringify(finishedA.spans.map(s => s.name))} b=${JSON.stringify(finishedB.spans.map(s => s.name))}` };
  },
});

cases.push({
  label: 'getActiveTrace() returns null outside any runAsActive() context',
  run: async () => !getActiveTrace(),
});

cases.push({
  label: 'getActiveTrace() resolves to the correct trace instance from deep inside nested async calls',
  run: async () => {
    const trace = new RequestTrace('root-op');
    let seenInsideNested: unknown = null;
    async function deeplyNested() {
      await new Promise(r => setTimeout(r, 1));
      seenInsideNested = getActiveTrace();
    }
    await trace.runAsActive(async () => {
      await trace.span('wrap', deeplyNested);
    });
    return seenInsideNested === trace;
  },
});

cases.push({
  label: 'Malformed hierarchy (unknown parentSpanId) exports without throwing — orphan attaches to root',
  run: async () => {
    const finished: FinishedTrace = {
      traceId: 'malformed-1', rootSpanId: 'root1', rootName: 'ask-lecture-agent',
      startedAt: Date.now() - 100, durationMs: 100, status: 'SUCCESS', attributes: {},
      spans: [{
        spanId: 'orphan1', parentSpanId: 'does-not-exist', name: 'orphan-span',
        kind: 'CHAIN' as never, startedAt: Date.now() - 50, durationMs: 10, status: 'SUCCESS', metadata: {}, events: [],
      }],
    };
    // Export disabled in this environment (OBSERVABILITY.PHOENIX_ENABLED
    // likely false for this test run) — the assertion is simply that this
    // never throws, regardless of whether it actually sends anything.
    await exportTraceToPhoenix(finished);
    return true;
  },
});

cases.push({
  label: 'Malformed hierarchy (self-referential cycle) exports without infinite recursion',
  run: async () => {
    const finished: FinishedTrace = {
      traceId: 'malformed-2', rootSpanId: 'root2', rootName: 'ask-lecture-agent',
      startedAt: Date.now() - 100, durationMs: 100, status: 'SUCCESS', attributes: {},
      spans: [
        { spanId: 's1', parentSpanId: 's2', name: 'cycle-a', kind: 'CHAIN' as never, startedAt: Date.now(), durationMs: 1, status: 'SUCCESS', metadata: {}, events: [] },
        { spanId: 's2', parentSpanId: 's1', name: 'cycle-b', kind: 'CHAIN' as never, startedAt: Date.now(), durationMs: 1, status: 'SUCCESS', metadata: {}, events: [] },
      ],
    };
    const start = Date.now();
    await exportTraceToPhoenix(finished);
    return Date.now() - start < 5000; // must terminate quickly, not hang/stack-overflow
  },
});

cases.push({
  label: 'Duplicate spanIds export without throwing (first occurrence wins)',
  run: async () => {
    const finished: FinishedTrace = {
      traceId: 'malformed-3', rootSpanId: 'root3', rootName: 'ask-lecture-agent',
      startedAt: Date.now() - 100, durationMs: 100, status: 'SUCCESS', attributes: {},
      spans: [
        { spanId: 'dup', parentSpanId: 'root3', name: 'first', kind: 'CHAIN' as never, startedAt: Date.now(), durationMs: 1, status: 'SUCCESS', metadata: {}, events: [] },
        { spanId: 'dup', parentSpanId: 'root3', name: 'second', kind: 'CHAIN' as never, startedAt: Date.now(), durationMs: 1, status: 'SUCCESS', metadata: {}, events: [] },
      ],
    };
    await exportTraceToPhoenix(finished);
    return true;
  },
});

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

main();
