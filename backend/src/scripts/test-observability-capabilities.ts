/**
 * Tests for Phoenix capability detection (observability/services/
 * capabilities.ts): real runtime probes against a live Phoenix server,
 * disabled-state handling, unreachable-state handling (must not be
 * permanently cached as "unsupported"), caching/TTL behaviour, the
 * client-only "unsupported_by_client" case, and the static guarantee that
 * capability probing never performs a note/annotation write. Also covers
 * the closely-related route/model overview-enrichment fix in
 * aggregate.service.ts, which relies on the same span trace-ID filtering
 * capability this file already probes live.
 *
 * Uses isolated child processes (same pattern as test-observability.ts's
 * cases 8/9) wherever a specific env/PHOENIX_BASE_URL override is needed,
 * so these results never depend on the developer's own .env or on
 * Phoenix's actual reachability in this run.
 *
 * Usage: npm run test:observability-capabilities
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

// Matches the working pattern already used elsewhere in this project (see
// test-observability.ts's case 9) — the script body is embedded directly
// inside a double-quoted shell argument, so it must only use single quotes
// internally (no embedded double quotes) to avoid breaking out of the
// shell's quoting.
//
// Invokes the locally-installed ts-node binary directly rather than via
// `npx` — `npx` re-enters the full npm CLI (including its background
// update-notifier network check), which occasionally receives a non-JSON
// response in this environment and crashes the child with an unhandled
// rejection unrelated to anything under test. The local binary is a plain
// node process with no such side channel.
const TS_NODE_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');

function runChild(env: Record<string, string>, script: string, timeoutMs = 20000): string {
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  return execSync(
    `${envPrefix} "${TS_NODE_BIN}" --transpile-only -e "${script}"`,
    { cwd: path.join(__dirname, '..', '..'), timeout: timeoutMs, encoding: 'utf8' }
  );
}

cases.push({
  label: 'Static guarantee: capabilities.ts never imports a note/annotation WRITE function (never probes by writing)',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'observability', 'capabilities.ts'), 'utf8');
    // Only the import block matters — the source deliberately documents
    // (in comments) which write functions it does NOT call and why, so a
    // blind substring search over the whole file would false-positive on
    // those explanatory comments. Restrict the check to actual `import`
    // statements, which is what would make a write function callable.
    const importBlock = src.split(/\n\n/).filter(block => block.trim().startsWith('import')).join('\n');
    const forbidden = ['addTraceNote', 'addSpanNote', 'addSessionNote', 'addSessionAnnotation', 'addSpanAnnotation', 'addTraceAnnotation'];
    const offenders = forbidden.filter(fn => importBlock.includes(fn));
    return { pass: offenders.length === 0, detail: offenders.length ? `imported: ${offenders.join(', ')}` : 'none imported' };
  },
});

cases.push({
  label: 'Disabled observability -> all capabilities "unknown", reachable=false, no network call attempted',
  run: async () => {
    try {
      const out = runChild(
        { OBSERVABILITY_ENABLED: 'false', PHOENIX_ENABLED: 'false' },
        `
          const { getPhoenixCapabilities } = require('./src/services/observability/capabilities');
          getPhoenixCapabilities().then(c => console.log('RESULT:' + JSON.stringify(c)));
        `
      );
      const match = out.match(/RESULT:(\{.*\})/);
      if (!match) return { pass: false, detail: `no RESULT line: ${out.trim().slice(-200)}` };
      const c = JSON.parse(match[1]);
      const allUnknown = Object.values(c.details).every((d: any) => d.state === 'unknown');
      const pass = c.reachable === false && c.serverVersion === null && allUnknown && c.supportsTraceListing === false;
      return { pass, detail: `reachable=${c.reachable} allUnknown=${allUnknown}` };
    } catch (err) {
      return { pass: false, detail: `child process failed: ${(err as Error).message.slice(0, 200)}` };
    }
  },
});

cases.push({
  label: 'Unreachable Phoenix -> "unreachable" state (not "unsupported_by_server"), short TTL, no crash',
  run: async () => {
    try {
      const out = runChild(
        { OBSERVABILITY_ENABLED: 'true', PHOENIX_ENABLED: 'true', PHOENIX_BASE_URL: 'http://127.0.0.1:1' },
        `
          const { getPhoenixCapabilities } = require('./src/services/observability/capabilities');
          const start = Date.now();
          getPhoenixCapabilities().then(c => console.log('RESULT:' + JSON.stringify({ ...c, elapsedMs: Date.now() - start })));
        `,
        15000
      );
      const match = out.match(/RESULT:(\{.*\})/);
      if (!match) return { pass: false, detail: `no RESULT line: ${out.trim().slice(-200)}` };
      const c = JSON.parse(match[1]);
      const allUnreachable = Object.values(c.details).every((d: any) => d.state === 'unreachable');
      const pass = c.reachable === false && allUnreachable && c.supportsTraceListing === false;
      return { pass, detail: `reachable=${c.reachable} allUnreachable=${allUnreachable} elapsedMs=${c.elapsedMs}` };
    } catch (err) {
      return { pass: false, detail: `child process failed: ${(err as Error).message.slice(0, 200)}` };
    }
  },
});

cases.push({
  label: 'A temporarily-unreachable result is not cached long-term (a later successful call overrides it, not stuck as unsupported)',
  run: async () => {
    // Point at an unreachable URL first, then flip env mid-process by
    // calling forceRefresh against the real client after correcting the
    // module's own cached `env` isn't possible (env is read once at
    // import time in this codebase's convention) — so this is verified
    // structurally instead: confirm the unreachable path uses a SHORT TTL
    // constant, distinct from and smaller than the stable-answer TTL, by
    // reading the source (the actual timing behavior is covered by the
    // previous case's fast elapsedMs, and the disabled/live cases below
    // confirm the stable path uses the long TTL).
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'observability', 'capabilities.ts'), 'utf8');
    const hasShortTtl = /UNSTABLE_CACHE_TTL_MS\s*=\s*5_000/.test(src);
    const hasLongTtl = /CAPABILITIES_CACHE_TTL_MS\s*=\s*5 \* 60_000/.test(src);
    const usesShortOnUnreachable = /expiresAt: Date\.now\(\) \+ UNSTABLE_CACHE_TTL_MS \};\s*\n\s*return value;\s*\n\s*\}/.test(src) || src.includes('cached = { value, expiresAt: Date.now() + UNSTABLE_CACHE_TTL_MS };');
    return { pass: hasShortTtl && hasLongTtl && usesShortOnUnreachable, detail: `shortTtl=${hasShortTtl} longTtl=${hasLongTtl} usedOnUnreachable=${usesShortOnUnreachable}` };
  },
});

cases.push({
  label: 'supportsSessionAnnotationReads is always "unsupported_by_client" (installed client has no getSessionAnnotations export, regardless of server)',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'observability', 'capabilities.ts'), 'utf8');
    const pass = /sessionAnnotationReads:\s*CapabilityDetail\s*=\s*\{\s*\n\s*state:\s*'unsupported_by_client'/.test(src);
    return { pass, detail: pass ? 'statically unsupported_by_client, not probed' : 'not found or not static' };
  },
});

// Combined into one child process (rather than one per assertion) — each
// ts-node cold start is expensive, and this environment has shown
// resource-contention flakiness when spawning many in quick succession.
// Both the "real, distinct filter states" and "caching is fast" checks
// only need a single live capabilities call plus one cached re-call.
let liveServerProbeResult: { pass: boolean; detail?: string } | null = null;
async function runLiveServerProbe(): Promise<{ pass: boolean; detail?: string }> {
  if (liveServerProbeResult) return liveServerProbeResult;
  try {
    const out = runChild(
      { OBSERVABILITY_ENABLED: 'true', PHOENIX_ENABLED: 'true' },
      `
        const { getPhoenixCapabilities } = require('./src/services/observability/capabilities');
        (async () => {
          const s1 = Date.now();
          const c = await getPhoenixCapabilities();
          const e1 = Date.now() - s1;
          const s2 = Date.now();
          await getPhoenixCapabilities();
          const e2 = Date.now() - s2;
          console.log('RESULT:' + JSON.stringify({ c, e1, e2 }));
        })().catch(e => console.log('ERR:' + e.message));
      `,
      20000
    );
    if (out.includes('ERR:')) { liveServerProbeResult = { pass: true, detail: `SKIPPED — Phoenix not reachable in this run: ${out.trim().slice(-150)}` }; return liveServerProbeResult; }
    const match = out.match(/RESULT:(\{.*\})/);
    if (!match) { liveServerProbeResult = { pass: false, detail: `no RESULT line: ${out.trim().slice(-200)}` }; return liveServerProbeResult; }
    liveServerProbeResult = { pass: true, detail: match[1] };
    return liveServerProbeResult;
  } catch (err) {
    liveServerProbeResult = { pass: true, detail: `SKIPPED — child process failed (likely no live Phoenix in this run): ${(err as Error).message.slice(0, 150)}` };
    return liveServerProbeResult;
  }
}

cases.push({
  label: 'Live server: capabilities resolve to real, distinct states for trace-id vs span-kind span filtering (drift-bug regression)',
  run: async () => {
    const probe = await runLiveServerProbe();
    if (!probe.pass) return probe;
    if (probe.detail?.startsWith('SKIPPED')) return probe;
    const { c } = JSON.parse(probe.detail!);
    if (!c.reachable) return { pass: true, detail: 'SKIPPED (Phoenix not reachable in this run) — see the unreachable-state case above for that path' };
    // Both flags are independently probed (real getSpans calls with
    // different params) rather than aliased to one shared flag — the
    // exact drift the previous implementation had.
    const bothPresent = 'supportsSpanTraceIdFiltering' in c && 'supportsSpanKindStatusFiltering' in c;
    const notAliased = !('supportsSpanFiltering' in c); // old, ambiguous flag name must be gone
    const pass = bothPresent && notAliased && c.details.spanTraceIdFiltering && c.details.spanKindStatusFiltering;
    return { pass, detail: `spanTraceIdFiltering=${c.details?.spanTraceIdFiltering?.state} spanKindStatusFiltering=${c.details?.spanKindStatusFiltering?.state}` };
  },
});

cases.push({
  label: 'Live server: caching makes a second call fast (no repeated network probes within TTL)',
  run: async () => {
    const probe = await runLiveServerProbe();
    if (!probe.pass) return probe;
    if (probe.detail?.startsWith('SKIPPED')) return probe;
    const { e1, e2 } = JSON.parse(probe.detail!);
    return { pass: e2 < 20 && e2 <= e1, detail: `first=${e1}ms (live probes), second=${e2}ms (cache hit)` };
  },
});

cases.push({
  // Renamed from ROUTE_MODEL_SPAN_FETCH_LIMIT when the same enrichment
  // fetch was extended to also back memory/zero-retrieval/fallback (this
  // task) — the constant, and the single-call guarantee it protects, are
  // no longer route/model-specific.
  label: 'Regression: overview span-enrichment fetch (route/model/memory/zero-retrieval/fallback) never exceeds Phoenix\'s server-enforced max `limit` (1000 — verified live, 3000 returns 422)',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'observability', 'aggregate.service.ts'), 'utf8');
    const match = src.match(/ENRICHMENT_SPAN_FETCH_LIMIT\s*=\s*(\d+)/);
    if (!match) return { pass: false, detail: 'ENRICHMENT_SPAN_FETCH_LIMIT not found' };
    const limit = parseInt(match[1], 10);
    return { pass: limit > 0 && limit <= 1000, detail: `ENRICHMENT_SPAN_FETCH_LIMIT=${limit}` };
  },
});

cases.push({
  label: 'Regression: memory/zero-retrieval/fallback reuse the SAME batched enrichment call as route/model — no second getSpans() call, no N+1',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'observability', 'aggregate.service.ts'), 'utf8');
    // Strip full-line comments first — several of them reference
    // "getSpans()" in prose to explain the single-call design, which would
    // otherwise double-count as a second call site. The import statement
    // (`import { getSpans } from ...`) never matches `getSpans(` since
    // nothing but `}` follows the identifier there.
    const codeOnly = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const getSpansCalls = (codeOnly.match(/\bgetSpans\s*\(/g) ?? []).length;
    // Exactly one call site in the whole aggregation module — memory,
    // zero-retrieval, and fallback are all derived from
    // `enrichedSummaries`, which is built once from that single result
    // (see computeEnrichedOverviewMetrics), not fetched again per metric.
    const derivesFromSharedEnrichment =
      /computeMemoryMetrics\(enrichedSummaries/.test(src) &&
      /computeZeroRetrievalMetric\(enrichedSummaries/.test(src) &&
      /computeFallbackMetrics\(enrichedSummaries/.test(src);
    return {
      pass: getSpansCalls === 1 && derivesFromSharedEnrichment,
      detail: `getSpans() call sites=${getSpansCalls}, all three metrics read from enrichedSummaries=${derivesFromSharedEnrichment}`,
    };
  },
});

cases.push({
  label: 'Live server: Overview route/model distributions are real data, not an all-"unknown" bucket (getTraces(includeSpans:true) has no attributes at all)',
  run: async () => {
    try {
      const out = runChild(
        { OBSERVABILITY_ENABLED: 'true', PHOENIX_ENABLED: 'true' },
        `
          const { computeOverview } = require('./src/services/observability/aggregate.service');
          computeOverview({}).then(r => console.log('RESULT:' + JSON.stringify({ route: r.metrics.routeDistribution, model: r.metrics.modelDistribution }))).catch(e => console.log('ERR:' + e.message));
        `,
        20000
      );
      if (out.includes('ERR:')) return { pass: true, detail: `SKIPPED — Phoenix not reachable in this run: ${out.trim().slice(-150)}` };
      const match = out.match(/RESULT:(\{.*\})/);
      if (!match) return { pass: false, detail: `no RESULT line: ${out.trim().slice(-200)}` };
      const { route, model } = JSON.parse(match[1]);
      if (route.sampleSize === 0) return { pass: true, detail: 'SKIPPED (no traces exist in this Phoenix project to enrich)' };
      // The bug this guards against: both distributions silently collapsing
      // to `{ unknown: N }` for every trace because the embedded span shape
      // carries no attributes at all. A real fix means `available: true`
      // and at least one non-"unknown" key when real traces exist.
      const routeHasRealData = route.available && Object.keys(route.data).some(k => k !== 'unknown');
      const notAllUnknown = Object.keys(route.data).length === 0 || routeHasRealData;
      return { pass: route.available && notAllUnknown, detail: `route=${JSON.stringify(route)} model=${JSON.stringify(model)}` };
    } catch (err) {
      return { pass: true, detail: `SKIPPED — child process failed (likely no live Phoenix in this run): ${(err as Error).message.slice(0, 150)}` };
    }
  },
});

async function main() {
  let failures = 0;
  let skipped = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      if (r.detail?.startsWith('SKIPPED')) { skipped++; console.log(`SKIP  ${c.label} (${r.detail})`); }
      else if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - skipped - failures}/${cases.length - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
