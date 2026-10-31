import { query } from '../config/database';
import { env } from '../config/env';
import { resolveEmbeddingProvider } from '../embedding/embedding-provider.resolver';
import { resolveRerankProvider } from '../rerank/rerank-provider.resolver';
import { logger } from '../utils/logger';
import { classifyErrorCode } from './tracer';
import { providerDownSignal, type ProviderComponent } from './provider-signal';

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy';
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentHealth {
  status: ComponentStatus;
  latencyMs: number;
  errorCode?: string;
}

export interface ReadinessResult {
  status: OverallStatus;
  checkedAt: string;
  components: {
    database: ComponentHealth;
    pgvector: ComponentHealth;
    embeddingServer: ComponentHealth;
    reranker: ComponentHealth;
    // The model that writes the answers (RAG_LLM_PROVIDER), whichever it is.
    answerLlm: ComponentHealth;
  };
}

// Every component a lecture question needs is REQUIRED: if one is unhealthy no
// question can be answered, so readiness is `unhealthy` (HTTP 503) and a load
// balancer / uptime monitor sees it. That is the database, pgvector, the
// embedding provider, the reranker (a rerank failure fails the question) and
// the answer LLM, whichever provider it is. `degraded` (HTTP 200) is left for
// what is uncertain rather than down: a check that only verified config (e.g.
// HEALTH_GEMINI_CHECK_ENABLED=false), or an answer provider with no probe
// (UNVERIFIED_PROVIDER) — never `healthy` for something that wasn't checked.
type ComponentName = keyof ReadinessResult['components'];
export const requiredComponents = (): ComponentName[] => [
  'database', 'pgvector', 'embeddingServer', 'reranker', 'answerLlm',
];

// Probes the provider that answers questions. Only Gemini has a probe; for any
// other provider readiness must not claim it is healthy.
async function probeAnswerLlm(provider: string): Promise<ComponentHealth> {
  return provider === 'gemini'
    ? checkGemini()
    : { status: 'degraded', latencyMs: 0, errorCode: 'UNVERIFIED_PROVIDER' };
}

// Whatever the provider, recent REAL answer calls are consulted too
// (provider-signal.ts, fed by generateAnswer): if they keep failing the answer
// LLM is unhealthy — otherwise a Groq outage left /health/ready at 200 while
// every question failed.
export async function checkAnswerLlm(provider = env.LLM.RAG_ANSWER.PROVIDER): Promise<ComponentHealth> {
  return withProviderSignal('answerLlm')(await probeAnswerLlm(provider));
}

// A component whose recent real calls keep failing is unhealthy, whatever its
// probe or config check said. Applied AFTER the readiness cache, never inside
// it: a cached result with the signal baked in kept a recovered provider
// unhealthy (and /health/ready at 503) for the rest of the cache TTL, though
// one successful call had already cleared the signal.
const withProviderSignal = (c: ProviderComponent) => (h: ComponentHealth): ComponentHealth => {
  if (h.status === 'unhealthy') return h;
  const down = providerDownSignal(c);
  return down ? { status: 'unhealthy', latencyMs: h.latencyMs, errorCode: down } : h;
};

interface CacheEntry { result: ComponentHealth; checkedAtMs: number; }
const cache = new Map<string, CacheEntry>();
/** Tests only. */
export const resetHealthCache = (): void => cache.clear();

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, latencyMs };
}

// A failed probe is re-checked sooner than a passing one, so a recovered
// dependency rejoins the load balancer within seconds, not a full TTL.
export const UNHEALTHY_CACHE_TTL_MS = 5_000;

async function cached(
  key: string,
  ttlMs: number,
  compute: () => Promise<ComponentHealth>
): Promise<ComponentHealth> {
  const entry = cache.get(key);
  const entryTtl = entry?.result.status === 'unhealthy' ? Math.min(ttlMs, UNHEALTHY_CACHE_TTL_MS) : ttlMs;
  if (entry && Date.now() - entry.checkedAtMs < entryTtl) {
    return entry.result;
  }
  const result = await compute().catch((err): ComponentHealth => ({
    status: 'unhealthy',
    latencyMs: 0,
    errorCode: classifyErrorCode(err),
  }));
  cache.set(key, { result, checkedAtMs: Date.now() });
  return result;
}

async function checkDatabase(): Promise<ComponentHealth> {
  try {
    const { latencyMs } = await timed(() => query('SELECT 1'));
    return { status: 'healthy', latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
  }
}

async function checkPgvector(): Promise<ComponentHealth> {
  try {
    const { result, latencyMs } = await timed(() =>
      query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = 'vector'`)
    );
    if (result.rows.length === 0) {
      return { status: 'unhealthy', latencyMs: Math.round(latencyMs), errorCode: 'EXTENSION_NOT_INSTALLED' };
    }
    return { status: 'healthy', latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
  }
}

// Reachability only — does not run a real embedding/rerank on every check.
// Any HTTP response (even 404/405 for an unmatched route) proves the
// process is up and listening; a connection failure/timeout does not.
async function checkHttpReachable(url: string): Promise<ComponentHealth> {
  const origin = new URL(url).origin;
  try {
    const start = process.hrtime.bigint();
    await fetch(origin, { method: 'GET', signal: AbortSignal.timeout(3000) });
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    return { status: 'healthy', latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
  }
}

// Never a paid call per probe:
//   - provider with an HTTP endpoint of its own (the local server): reachability;
//   - hosted provider with a free probe() (OpenAI: model metadata; Voyage:
//     an authenticated listing that runs no model): run it;
//   - hosted provider without one: config check.
// With `component`, recent REAL calls are consulted too (provider-signal.ts): a
// provider whose last calls kept failing is unhealthy even if it looks
// reachable/configured. checkReadiness leaves it out and applies the signal
// after its cache instead (see withProviderSignal).
export async function checkProviderHealth(
  provider: { healthUrl?: string; assertConfigured(): void; probe?(): Promise<void> },
  component?: ProviderComponent,
): Promise<ComponentHealth> {
  let base: ComponentHealth;
  if (provider.healthUrl) {
    base = await checkHttpReachable(provider.healthUrl);
  } else {
    try {
      provider.assertConfigured();
    } catch {
      return { status: 'unhealthy', latencyMs: 0, errorCode: 'NOT_CONFIGURED' };
    }
    if (provider.probe) {
      try {
        const { latencyMs } = await timed(() => provider.probe!());
        base = { status: 'healthy', latencyMs: Math.round(latencyMs) };
      } catch (err) {
        return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
      }
    } else {
      base = { status: 'healthy', latencyMs: 0 };
    }
  }
  if (base.status !== 'healthy' || !component) return base;
  const down = providerDownSignal(component);
  return down ? { status: 'unhealthy', latencyMs: base.latencyMs, errorCode: down } : base;
}

async function checkGemini(): Promise<ComponentHealth> {
  if (!env.GEMINI_API_KEY) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: 'NOT_CONFIGURED' };
  }
  if (!env.HEALTH.GEMINI_CHECK_ENABLED) {
    // Config-only check — key is present, connectivity unverified. Marked
    // degraded (uncertain), never a real network call on this path.
    return { status: 'degraded', latencyMs: 0 };
  }
  try {
    const { countTokens } = await import('../services/gemini-provider.service');
    const start = process.hrtime.bigint();
    // countTokens is a lightweight, no-generation call — validates auth and
    // connectivity without producing any model output.
    await countTokens('gemini-2.5-flash', 'ping');
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    return { status: 'healthy', latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
  }
}

// unhealthy if a required component is down; degraded if anything else is not
// healthy (or a required one is only unverified); healthy otherwise.
export function overallStatus(components: ReadinessResult['components'], required: ComponentName[]): OverallStatus {
  if (required.some(name => components[name].status === 'unhealthy')) return 'unhealthy';
  return Object.values(components).some(c => c.status !== 'healthy') ? 'degraded' : 'healthy';
}

export function checkLiveness(): { status: 'ok'; timestamp: string } {
  return { status: 'ok', timestamp: new Date().toISOString() };
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const ttl = env.HEALTH.CACHE_TTL_MS;

  // Only the probes are cached. The passive signal is a map lookup applied
  // AFTER the cache, so real calls that start failing show up at once, and a
  // success clears it at once — neither waits for the cached probe to expire.
  const [database, pgvector, embeddingServer, reranker, answerLlm] = await Promise.all([
    cached('database', ttl, checkDatabase),
    cached('pgvector', ttl, checkPgvector),
    cached('embeddingServer', ttl, () => checkProviderHealth(resolveEmbeddingProvider(env.RETRIEVAL.EMBEDDING_PROVIDER)))
      .then(withProviderSignal('embeddingServer')),
    cached('reranker', ttl, () => checkProviderHealth(resolveRerankProvider(env.RETRIEVAL.RERANK_PROVIDER)))
      .then(withProviderSignal('reranker')),
    cached(`answerLlm:${env.LLM.RAG_ANSWER.PROVIDER}`, ttl, () => probeAnswerLlm(env.LLM.RAG_ANSWER.PROVIDER))
      .then(withProviderSignal('answerLlm')),
  ]);

  const components = { database, pgvector, embeddingServer, reranker, answerLlm };

  const status = overallStatus(components, requiredComponents());

  if (status !== 'healthy') {
    logger.warn(`[HEALTH] Readiness=${status} — ${JSON.stringify(Object.fromEntries(Object.entries(components).map(([k, v]) => [k, v.status])))}`);
  }

  return { status, checkedAt: new Date().toISOString(), components };
}
