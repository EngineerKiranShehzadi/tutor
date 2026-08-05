import { getTraces } from '@arizeai/phoenix-client/traces';
import { getSpans } from '@arizeai/phoenix-client/spans';
import { listSessions } from '@arizeai/phoenix-client/sessions';
// Public, stable utilities the client itself uses to gate its own calls —
// see the long comment block below for why these (and not the private
// requirement-constant table) are what this module treats as authoritative.
import { ensureServerCapability } from '@arizeai/phoenix-client/utils/serverVersionUtils';
import type { CapabilityRequirement } from '@arizeai/phoenix-client/types/serverRequirements';
import { env } from '../../config/env';
import { getPhoenixClient, phoenixProject } from './phoenix-client';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────
// How capability detection works here, and why
//
// @arizeai/phoenix-client's own functions (getTraces, getSpans,
// listSessions, getSession, addTraceNote, addSessionAnnotation, ...)
// already call an internal `ensureServerCapability()` guard before making
// certain requests, comparing the connected server's version against a
// private per-feature threshold table (dist/src/constants/
// serverRequirements.js). That table is NOT part of the package's public
// `exports` map (verified: `require('@arizeai/phoenix-client/constants/
// serverRequirements')` throws ERR_PACKAGE_PATH_NOT_EXPORTED), so we
// cannot import it directly — but `ensureServerCapability` and the
// semver comparator it uses (`satisfiesMinVersion`, in `./utils/
// semverUtils`) ARE public, stable exports (under the `./utils/*` map).
//
// This module uses two different strategies depending on whether the
// underlying capability can be safely verified with a real, side-effect-
// free API call:
//
// 1. REAL RUNTIME PROBES (preferred): for every capability backed by a
//    safe read-only call, we make that exact call with harmless/minimal
//    parameters (limit: 1, a made-up ID that won't match anything) and
//    let the client's own internal `ensureServerCapability` guard do the
//    real work. This is strictly more accurate than duplicating version
//    numbers: it reflects the ACTUAL installed client's behavior against
//    the ACTUAL connected server, not our guess at either. See
//    `probeCall()`.
//
// 2. VERSION-GATED, NO-PROBE (fallback): a handful of capabilities are
//    write endpoints (trace notes, session notes, session annotations).
//    The task this module serves explicitly forbids probing those by
//    performing a real write. For these we call `ensureServerCapability`
//    directly with a LOCALLY MIRRORED requirement object (copied from the
//    private table above, with the exact values and a citation of where
//    they came from) — `ensureServerCapability` itself does ZERO network
//    I/O beyond the server-version fetch already cached on the client
//    instance (see phoenix-client.ts's singleton), so this costs nothing
//    extra, but it IS still vulnerable to drift if @arizeai/phoenix-client
//    is upgraded and silently changes these thresholds. Each mirrored
//    constant below is commented with the exact source line to re-check
//    when bumping the dependency.
//
// A few capabilities have no client-side gate of any kind (confirmed by
// reading the actual call sites — see per-flag comments below); those are
// hardcoded 'supported' with a citation, not a guess.
// ─────────────────────────────────────────────────────────────────────────

export type CapabilityState =
  | 'supported'
  | 'unsupported_by_server'   // connected Phoenix server is too old
  | 'unsupported_by_client'   // installed @arizeai/phoenix-client has no code path for this at all, regardless of server version
  | 'unreachable'             // could not determine (network/timeout) — NOT the same as unsupported, must not be cached long-term as such
  | 'unknown';                // determination not attempted for this capability (e.g. Phoenix disabled)

export interface CapabilityDetail {
  state: CapabilityState;
  detail?: string;
}

export interface PhoenixCapabilities {
  serverVersion: string | null;
  reachable: boolean;
  observabilityEnabled: boolean;
  phoenixEnabled: boolean;

  // Convenience booleans for existing `if (caps.supportsX)` call sites —
  // each is exactly `details.<key>.state === 'supported'`. Prefer reading
  // `details` directly for the full 5-way distinction (e.g. to render
  // "temporarily unavailable" differently from "not supported").
  supportsTraceListing: boolean;
  supportsInlineSpans: boolean;
  supportsSpanTraceIdFiltering: boolean;
  supportsSpanIdFiltering: boolean;
  supportsSpanKindStatusFiltering: boolean;
  supportsAttributeFiltering: boolean;
  supportsSessions: boolean;
  supportsSessionTurns: boolean;
  supportsSessionAnnotations: boolean;
  supportsSessionAnnotationReads: boolean;
  supportsSessionNotes: boolean;
  supportsTraceNotes: boolean;
  supportsSpanNotes: boolean;
  supportsTokenAggregates: boolean;
  supportsAnnotations: boolean;
  /** @deprecated kept for backward compatibility with older call sites/UI — equals supportsSpanNotes && supportsTraceNotes. Prefer the specific flags. */
  supportsNotes: boolean;

  details: Record<string, CapabilityDetail>;
  checkedAt: string;
}

// ── Locally-mirrored requirement constants for the write-only, no-probe
// capabilities. Source: node_modules/@arizeai/phoenix-client/dist/src/
// constants/serverRequirements.js (private module, not importable — see
// header comment). Re-verify these three against that file whenever
// @arizeai/phoenix-client is upgraded in package.json.
const ADD_TRACE_NOTE: CapabilityRequirement = {
  kind: 'route', method: 'POST', path: '/v1/trace_notes', minServerVersion: [14, 13, 0],
};
const ADD_SESSION_NOTE: CapabilityRequirement = {
  kind: 'route', method: 'POST', path: '/v1/session_notes', minServerVersion: [14, 17, 0],
};
const ANNOTATE_SESSIONS: CapabilityRequirement = {
  kind: 'route', method: 'POST', path: '/v1/session_annotations', minServerVersion: [12, 0, 0],
};

const PROBE_TIMEOUT_MS = 5_000;
const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000; // stable answer (known-good or known-too-old) — no need to recheck often
const UNSTABLE_CACHE_TTL_MS = 5_000;          // any probe was unreachable/unknown this cycle — retry soon rather than caching a guess

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Phoenix capability probe exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// Classifies the outcome of a real, live probe call. The client's own
// `ensureServerCapability` throws a message containing "requires Phoenix
// server >=" when the connected server is too old — see
// serverVersionUtils.js's ensureServerCapability. Any other thrown error
// (timeout, network failure, unexpected server error) is a genuinely
// indeterminate result, not a confirmed "unsupported".
async function probeCall(fn: () => Promise<unknown>): Promise<CapabilityDetail> {
  try {
    await withTimeout(fn, PROBE_TIMEOUT_MS);
    return { state: 'supported' };
  } catch (err) {
    const message = (err as Error)?.message ?? 'Unknown error';
    if (/requires Phoenix server/i.test(message)) {
      return { state: 'unsupported_by_server', detail: message };
    }
    return { state: 'unknown', detail: message.slice(0, 200) };
  }
}

// For the write-only capabilities we must not probe by writing — this
// costs no network I/O (ensureServerCapability only re-reads the already-
// cached server version on the singleton client, see phoenix-client.ts),
// but is still a version-threshold check, not a real probe. See the
// module header comment.
async function versionGatedNoProbe(requirement: CapabilityRequirement): Promise<CapabilityDetail> {
  try {
    await ensureServerCapability({ client: getPhoenixClient(), requirement });
    return { state: 'supported' };
  } catch (err) {
    const message = (err as Error)?.message ?? 'Unknown error';
    if (/requires Phoenix server/i.test(message)) {
      return { state: 'unsupported_by_server', detail: message };
    }
    return { state: 'unknown', detail: message.slice(0, 200) };
  }
}

let cached: { value: PhoenixCapabilities; expiresAt: number } | null = null;

function disabledCapabilities(): PhoenixCapabilities {
  const unknown: CapabilityDetail = { state: 'unknown', detail: 'Observability/Phoenix is disabled in this environment' };
  const keys = [
    'traceListing', 'inlineSpans', 'spanTraceIdFiltering', 'spanIdFiltering', 'spanKindStatusFiltering',
    'attributeFiltering', 'sessions', 'sessionTurns', 'sessionAnnotations', 'sessionAnnotationReads',
    'sessionNotes', 'traceNotes', 'spanNotes', 'tokenAggregates', 'annotations',
  ];
  return {
    serverVersion: null,
    reachable: false,
    observabilityEnabled: env.OBSERVABILITY.ENABLED,
    phoenixEnabled: env.OBSERVABILITY.PHOENIX_ENABLED,
    supportsTraceListing: false,
    supportsInlineSpans: false,
    supportsSpanTraceIdFiltering: false,
    supportsSpanIdFiltering: false,
    supportsSpanKindStatusFiltering: false,
    supportsAttributeFiltering: false,
    supportsSessions: false,
    supportsSessionTurns: false,
    supportsSessionAnnotations: false,
    supportsSessionAnnotationReads: false,
    supportsSessionNotes: false,
    supportsTraceNotes: false,
    supportsSpanNotes: false,
    supportsTokenAggregates: false,
    supportsAnnotations: false,
    supportsNotes: false,
    details: Object.fromEntries(keys.map(k => [k, unknown])),
    checkedAt: new Date().toISOString(),
  };
}

export async function getPhoenixCapabilities(forceRefresh = false): Promise<PhoenixCapabilities> {
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  if (!env.OBSERVABILITY.ENABLED || !env.OBSERVABILITY.PHOENIX_ENABLED) {
    const value = disabledCapabilities();
    cached = { value, expiresAt: Date.now() + CAPABILITIES_CACHE_TTL_MS };
    return value;
  }

  const client = getPhoenixClient();
  const project = phoenixProject();

  let serverVersion: string | null = null;
  try {
    serverVersion = String(await withTimeout(() => client.getServerVersion(), PROBE_TIMEOUT_MS));
  } catch (err) {
    logger.warn(`[OBSERVABILITY] Phoenix capability check failed (server unreachable): ${(err as Error).message}`);
    const value = disabledCapabilities();
    value.observabilityEnabled = env.OBSERVABILITY.ENABLED;
    value.phoenixEnabled = env.OBSERVABILITY.PHOENIX_ENABLED;
    value.reachable = false;
    const unreachable: CapabilityDetail = { state: 'unreachable', detail: (err as Error).message.slice(0, 200) };
    for (const k of Object.keys(value.details)) value.details[k] = unreachable;
    // Short TTL — a transient outage must not get permanently cached as
    // "unsupported"; retry again soon.
    cached = { value, expiresAt: Date.now() + UNSTABLE_CACHE_TTL_MS };
    return value;
  }

  // Real runtime probes — each triggers the exact internal
  // ensureServerCapability() check the client itself uses for that call,
  // against a harmless/minimal request. Run once per cache window, not
  // per admin request.
  const probeToken = '__capability_probe_9f31a2__'; // won't match any real trace/span
  const [traceListing, spanTraceId, spanId, spanKindStatus, attributeFiltering, sessions] = await Promise.all([
    probeCall(() => getTraces({ client, project, limit: 1, includeSpans: true })),
    probeCall(() => getSpans({ client, project, limit: 1, traceIds: [probeToken] })),
    probeCall(() => getSpans({ client, project, limit: 1, spanIds: [probeToken] })),
    probeCall(() => getSpans({ client, project, limit: 1, spanKind: 'CHAIN' })),
    probeCall(() => getSpans({ client, project, limit: 1, attributes: { [probeToken]: 'x' } })),
    probeCall(() => listSessions({ client, ...project })),
  ]);

  // No separate client-side gate exists for either of these (verified:
  // getSessionTurns.js has no ensureServerCapability call at all; the
  // OpenAPI schema types TraceData.token_count_* as always-present with a
  // numeric @default, i.e. not a version-gated field) — they track the
  // capability they structurally depend on rather than being probed
  // independently.
  const sessionTurns: CapabilityDetail = sessions;
  const tokenAggregates: CapabilityDetail = traceListing;

  // Write-only capabilities — must not be probed via a real write (would
  // create actual notes/annotations as a side effect of a health check).
  const [sessionAnnotations, sessionNotes, traceNotes] = await Promise.all([
    versionGatedNoProbe(ANNOTATE_SESSIONS),
    versionGatedNoProbe(ADD_SESSION_NOTE),
    versionGatedNoProbe(ADD_TRACE_NOTE),
  ]);

  // Confirmed by reading the actual client source — no version gate
  // exists for these at all (addSpanNote.js only gates its optional
  // `identifier` param, not the base call; getSpanAnnotations.js,
  // addSpanAnnotation.js, addTraceAnnotation.js call no
  // ensureServerCapability whatsoever), so 'supported' here is a fact
  // about the installed client, not a guess.
  const spanNotes: CapabilityDetail = { state: 'supported', detail: 'No version gate exists in the installed client for span notes.' };
  const annotations: CapabilityDetail = { state: 'supported', detail: 'No version gate exists in the installed client for span/trace annotation read or write.' };

  // Confirmed by reading the client's public export surface (traces/
  // index.d.ts, sessions/index.d.ts) — no getSessionAnnotations (or
  // getTraceAnnotations) function exists at all in this installed
  // version. Not a server-version question — the installed client simply
  // has no code path for it, regardless of what server it's talking to.
  const sessionAnnotationReads: CapabilityDetail = {
    state: 'unsupported_by_client',
    detail: 'Installed @arizeai/phoenix-client has no getSessionAnnotations export in this version.',
  };

  const details: Record<string, CapabilityDetail> = {
    traceListing, inlineSpans: traceListing, spanTraceIdFiltering: spanTraceId, spanIdFiltering: spanId,
    spanKindStatusFiltering: spanKindStatus, attributeFiltering, sessions, sessionTurns,
    sessionAnnotations, sessionAnnotationReads, sessionNotes, traceNotes, spanNotes, tokenAggregates, annotations,
  };

  const value: PhoenixCapabilities = {
    serverVersion,
    reachable: true,
    observabilityEnabled: env.OBSERVABILITY.ENABLED,
    phoenixEnabled: env.OBSERVABILITY.PHOENIX_ENABLED,
    supportsTraceListing: traceListing.state === 'supported',
    supportsInlineSpans: traceListing.state === 'supported',
    supportsSpanTraceIdFiltering: spanTraceId.state === 'supported',
    supportsSpanIdFiltering: spanId.state === 'supported',
    supportsSpanKindStatusFiltering: spanKindStatus.state === 'supported',
    supportsAttributeFiltering: attributeFiltering.state === 'supported',
    supportsSessions: sessions.state === 'supported',
    supportsSessionTurns: sessionTurns.state === 'supported',
    supportsSessionAnnotations: sessionAnnotations.state === 'supported',
    supportsSessionAnnotationReads: sessionAnnotationReads.state === 'supported',
    supportsSessionNotes: sessionNotes.state === 'supported',
    supportsTraceNotes: traceNotes.state === 'supported',
    supportsSpanNotes: spanNotes.state === 'supported',
    supportsTokenAggregates: tokenAggregates.state === 'supported',
    supportsAnnotations: annotations.state === 'supported',
    supportsNotes: spanNotes.state === 'supported' && traceNotes.state === 'supported',
    details,
    checkedAt: new Date().toISOString(),
  };

  // Any probe landing on 'unknown' (indeterminate — not a confirmed
  // version mismatch) means something was flaky this cycle; don't cache
  // that guess for long. A clean sweep of 'supported'/'unsupported_by_server'
  // answers is stable and can be cached for the full TTL.
  const hadUnknown = Object.values(details).some(d => d.state === 'unknown');
  cached = { value, expiresAt: Date.now() + (hadUnknown ? UNSTABLE_CACHE_TTL_MS : CAPABILITIES_CACHE_TTL_MS) };
  return value;
}

// Test-only: reset the module-level cache between test cases.
export function __resetCapabilitiesCacheForTests(): void {
  cached = null;
}
