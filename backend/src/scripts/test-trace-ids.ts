/**
 * Tests for trace/span ID handling: RequestTrace ID format, isValidTraceId,
 * the Phoenix IdGenerator (pending slot semantics) and an end-to-end export
 * through exportTraceToPhoenix into an in-memory exporter.
 * No DB, no network, no Phoenix, no LLM.
 *
 * phoenix.ts loads its OpenTelemetry pieces with dynamic import(), which
 * ts-node compiles to require(). Two modules are replaced in require.cache
 * before the first export, so no production code is touched:
 *   - @opentelemetry/exporter-trace-otlp-proto -> an InMemorySpanExporter
 *     subclass (never opens a socket) that keeps every exported span;
 *   - @opentelemetry/sdk-trace-node -> the real NodeTracerProvider, subclassed
 *     only to capture the idGenerator phoenix.ts passes in and to run an
 *     optional probe right before startSpan() (the moment the pending IDs are
 *     set), so the generator can be observed exactly as OTel observes it.
 *
 * Usage: npm run test:trace-ids
 */
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { env } from '../config/env';
import { RequestTrace, isValidTraceId } from '../observability/tracer';
import { exportTraceToPhoenix, shutdownPhoenixExporter } from '../observability/phoenix';
import type { FinishedTrace } from '../observability/types';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } | Promise<boolean | { pass: boolean; detail?: string }> }
const cases: Case[] = [];

const TRACE_RE = /^[0-9a-f]{32}$/;
const SPAN_RE = /^[0-9a-f]{16}$/;
const nonZero = (id: string) => /[1-9a-f]/.test(id);
const validTrace = (id: string) => TRACE_RE.test(id) && nonZero(id);
const validSpan = (id: string) => SPAN_RE.test(id) && nonZero(id);

// ── Stubs for the OpenTelemetry modules phoenix.ts imports lazily ─────────────

interface IdGen { generateTraceId(): string; generateSpanId(): string }
let generator: IdGen | null = null;
let probe: ((g: IdGen) => void) | null = null;
const captured: ReadableSpan[] = [];

function stubModule(request: string, build: (real: Record<string, unknown>) => Record<string, unknown>): void {
  const id = require.resolve(request);
  const real = require(request) as Record<string, unknown>;
  const stub = build(real);
  Object.defineProperty(stub, '__esModule', { value: true });
  (require.cache[id] as NodeModule).exports = stub;
}

function installOtelStubs(): void {
  stubModule('@opentelemetry/exporter-trace-otlp-proto', () => ({
    OTLPTraceExporter: class extends InMemorySpanExporter {
      export(spans: ReadableSpan[], cb: Parameters<InMemorySpanExporter['export']>[1]): void {
        captured.push(...spans);
        super.export(spans, cb);
      }
    },
  }));

  stubModule('@opentelemetry/sdk-trace-node', real => {
    const Real = real.NodeTracerProvider as new (cfg: { idGenerator: IdGen }) => { getTracer(n: string): object };
    class Spy extends Real {
      constructor(cfg: { idGenerator: IdGen }) {
        super(cfg);
        generator = cfg.idGenerator;
      }
      getTracer(name: string): object {
        const tracer = super.getTracer(name) as Record<string, unknown>;
        return new Proxy(tracer, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop !== 'startSpan') return typeof value === 'function' ? value.bind(target) : value;
            return (...args: unknown[]) => {
              const p = probe;
              probe = null;
              if (p && generator) p(generator);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
      }
    }
    return { ...real, NodeTracerProvider: Spy };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildTrace(): Promise<FinishedTrace> {
  const t = new RequestTrace('ask-lecture-agent');
  await t.runAsActive(async () => {
    await t.span('query-router', async () => {
      await t.span('llm-call', async () => 'x');
    });
    await t.span('vector-search', async () => 'y');
  });
  return t.end('SUCCESS', { responseStatus: 'ANSWERED' });
}

function handBuilt(traceId: string, rootSpanId: string, spanId: string): FinishedTrace {
  return {
    traceId, rootSpanId, rootName: 'ask-lecture-agent', startedAt: Date.now(), durationMs: 10, status: 'SUCCESS',
    attributes: { responseStatus: 'ANSWERED' },
    spans: [{
      spanId, parentSpanId: rootSpanId, name: 'vector-search', kind: 'RETRIEVER' as FinishedTrace['spans'][number]['kind'],
      startedAt: Date.now(), durationMs: 5, status: 'SUCCESS', metadata: {}, events: [],
    }],
  };
}

const spanIdOf = (s: ReadableSpan) => s.spanContext().spanId;
const traceIdOf = (s: ReadableSpan) => s.spanContext().traceId;
const parentIdOf = (s: ReadableSpan): string | undefined => {
  const any = s as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string };
  return any.parentSpanContext?.spanId ?? any.parentSpanId;
};
const spansOfTrace = (id: string) => captured.filter(s => traceIdOf(s) === id);

// ── Results filled by prepare() (all exports happen before the flush) ─────────

let e2eTrace: FinishedTrace;
let e2eExported = false;
let invalidTrace: FinishedTrace;
let invalidExported = false;
let probeValid: { traceIds: string[]; spanIds: string[]; ours: { t: string; s: string } } | null = null;
let probeInvalid: { traceId: string; spanId: string } | null = null;
let afterExport: { traceId: string; spanId: string } | null = null;

async function prepare(): Promise<void> {
  const obs = env.OBSERVABILITY as unknown as Record<string, unknown>;
  obs.ENABLED = true;
  obs.PHOENIX_ENABLED = true;
  obs.SAMPLE_RATE = 1;
  obs.PHOENIX_ENDPOINT = 'http://phoenix.invalid/v1/traces';
  installOtelStubs();

  // Probe 1: valid pending IDs -> first call returns ours, second a random valid one.
  const ours = { t: 'c'.repeat(32), s: 'd'.repeat(16) };
  probe = g => {
    probeValid = { traceIds: [g.generateTraceId(), g.generateTraceId()], spanIds: [g.generateSpanId(), g.generateSpanId()], ours };
  };
  await exportTraceToPhoenix({ ...handBuilt(ours.t, ours.s, 'e'.repeat(16)), spans: [] });

  // Probe 2: invalid pending IDs -> a random valid ID, never the invalid string.
  probe = g => { probeInvalid = { traceId: g.generateTraceId(), spanId: g.generateSpanId() }; };
  await exportTraceToPhoenix({ ...handBuilt('not-a-trace-id', 'root', 'x'), spans: [] });

  // Real RequestTrace end to end.
  e2eTrace = await buildTrace();
  e2eExported = await exportTraceToPhoenix(e2eTrace);

  // Hand-built trace with invalid IDs (falls back to random IDs, tree preserved).
  invalidTrace = handBuilt('A'.repeat(32), 'root', 'child-1');
  invalidExported = await exportTraceToPhoenix(invalidTrace);

  // Slots must be empty again once an export is over.
  afterExport = { traceId: generator!.generateTraceId(), spanId: generator!.generateSpanId() };

  await shutdownPhoenixExporter();
}

// ── RequestTrace / isValidTraceId ─────────────────────────────────────────────

cases.push({
  label: 'RequestTrace.traceId is 32 lowercase hex and rootSpanId is 16 hex',
  run: () => {
    const t = new RequestTrace('root');
    return TRACE_RE.test(t.traceId) && validTrace(t.traceId) && SPAN_RE.test(t.rootSpanId);
  },
});

cases.push({
  label: 'RequestTrace keeps a caller-supplied traceId; IDs differ between traces',
  run: () => {
    const given = 'b'.repeat(32);
    const a = new RequestTrace('root', given);
    const ids = new Set(Array.from({ length: 50 }, () => new RequestTrace('root').traceId));
    return a.traceId === given && ids.size === 50;
  },
});

cases.push({
  label: 'Span IDs from span() and recordFallback() are 16 lowercase hex and unique',
  run: async () => {
    const t = new RequestTrace('root');
    await t.runAsActive(async () => {
      await t.span('a', async () => { await t.span('b', async () => 1); });
      t.recordFallback('c', 3);
    });
    const spans = t.end('SUCCESS').spans;
    const ids = spans.map(s => s.spanId);
    return spans.length === 3 && ids.every(id => SPAN_RE.test(id)) && new Set([...ids, t.rootSpanId]).size === 4;
  },
});

cases.push({
  label: 'isValidTraceId accepts valid 32-hex IDs',
  run: () => isValidTraceId('a'.repeat(32)) && isValidTraceId('0123456789abcdef0123456789abcdef') &&
    isValidTraceId('0'.repeat(31) + '1') && isValidTraceId(new RequestTrace('r').traceId),
});

cases.push({
  label: 'isValidTraceId rejects all-zero, short, long, uppercase, UUID and non-string values',
  run: () => {
    const bad: unknown[] = [
      '0'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '', 'A'.repeat(32), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA',
      '123e4567-e89b-12d3-a456-426614174000', 'g'.repeat(32), undefined, null, 12345, {},
    ];
    return bad.every(v => isValidTraceId(v) === false);
  },
});

// ── Phoenix IdGenerator ───────────────────────────────────────────────────────

cases.push({
  label: 'IdGenerator: pending trace ID is returned exactly once, then a random valid ID',
  run: () => {
    if (!probeValid) return { pass: false, detail: 'probe did not run' };
    const [first, second] = probeValid.traceIds;
    return first === probeValid.ours.t && second !== first && validTrace(second);
  },
});

cases.push({
  label: 'IdGenerator: pending span ID is returned exactly once, then a random valid ID',
  run: () => {
    if (!probeValid) return { pass: false, detail: 'probe did not run' };
    const [first, second] = probeValid.spanIds;
    return first === probeValid.ours.s && second !== first && validSpan(second);
  },
});

cases.push({
  label: 'IdGenerator: invalid pending trace/span IDs fall back to random valid ones',
  run: () => !!probeInvalid && validTrace(probeInvalid.traceId) && validSpan(probeInvalid.spanId) &&
    probeInvalid.traceId !== 'not-a-trace-id' && probeInvalid.spanId !== 'root',
});

cases.push({
  label: 'IdGenerator: slots are cleared after an export (next IDs are random valid)',
  run: () => !!afterExport && validTrace(afterExport.traceId) && validSpan(afterExport.spanId) &&
    afterExport.traceId !== e2eTrace.traceId && afterExport.spanId !== e2eTrace.rootSpanId,
});

// ── End to end: exportTraceToPhoenix -> in-memory exporter ────────────────────

cases.push({
  label: 'E2E: export reports true and every OTel span carries our trace ID',
  run: () => {
    const spans = spansOfTrace(e2eTrace.traceId);
    // root + query-router + llm-call + vector-search
    return e2eExported === true && spans.length === 4 && captured.filter(s => !validTrace(traceIdOf(s))).length === 0;
  },
});

cases.push({
  label: 'E2E: root span ID equals trace.rootSpanId and the root has no parent',
  run: () => {
    const root = spansOfTrace(e2eTrace.traceId).find(s => spanIdOf(s) === e2eTrace.rootSpanId);
    return !!root && root.name === e2eTrace.rootName && !parentIdOf(root);
  },
});

cases.push({
  label: 'E2E: child span IDs equal our span IDs, with our parent/child links',
  run: () => {
    const exported = spansOfTrace(e2eTrace.traceId).filter(s => spanIdOf(s) !== e2eTrace.rootSpanId);
    const ours = e2eTrace.spans;
    const sameIds = [...exported.map(spanIdOf)].sort().join() === ours.map(s => s.spanId).sort().join();
    const links = ours.every(o => {
      const e = exported.find(s => spanIdOf(s) === o.spanId);
      return !!e && e.name === o.name && parentIdOf(e) === o.parentSpanId;
    });
    return exported.length === 3 && sameIds && links;
  },
});

cases.push({
  label: 'E2E: invalid trace/root/span IDs still export, with random valid IDs and the tree intact',
  run: () => {
    const rootCandidates = captured.filter(s => s.name === 'ask-lecture-agent' && traceIdOf(s) !== e2eTrace.traceId &&
      traceIdOf(s) !== 'c'.repeat(32));
    const root = rootCandidates.find(s => !parentIdOf(s) && spansOfTrace(traceIdOf(s)).some(c => c.name === 'vector-search'));
    if (!invalidExported || !root) return { pass: false, detail: 'no exported root found' };
    const spans = spansOfTrace(traceIdOf(root));
    const child = spans.find(s => s.name === 'vector-search');
    return validTrace(traceIdOf(root)) && traceIdOf(root) !== invalidTrace.traceId && validSpan(spanIdOf(root)) &&
      !!child && validSpan(spanIdOf(child)) && spanIdOf(child) !== 'child-1' && parentIdOf(child) === spanIdOf(root);
  },
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  try {
    await prepare();
  } catch (err) {
    console.log(`FAIL  setup (threw: ${(err as Error).message})`);
    process.exit(1);
  }
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
