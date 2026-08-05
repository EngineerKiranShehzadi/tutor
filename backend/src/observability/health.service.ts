import { query } from '../config/database';
import { env } from '../config/env';
import { LOCAL_EMBED_URL } from '../services/embedding.service';
import { LOCAL_RERANK_URL } from '../services/rerank.service';
import { logger } from '../utils/logger';
import { classifyErrorCode } from './tracer';

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
    gemini: ComponentHealth;
  };
}

// database + pgvector + embeddingServer are required for any lecture
// question to be answerable at all -> their failure means `unhealthy`.
// reranker + gemini failing still leaves the backend process and
// non-RAG features (auth, lecture browsing, chat history) working ->
// `degraded`, not `unhealthy`.
const REQUIRED_COMPONENTS = ['database', 'pgvector', 'embeddingServer'] as const;

interface CacheEntry { result: ComponentHealth; checkedAtMs: number; }
const cache = new Map<string, CacheEntry>();

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, latencyMs };
}

async function cached(
  key: string,
  ttlMs: number,
  compute: () => Promise<ComponentHealth>
): Promise<ComponentHealth> {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.checkedAtMs < ttlMs) {
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
    const { getClient } = await import('../services/llm-gemini.service');
    const genAI = getClient();
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const start = process.hrtime.bigint();
    // countTokens is a lightweight, no-generation call — validates auth and
    // connectivity without producing any model output.
    await model.countTokens('ping');
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    return { status: 'healthy', latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: 0, errorCode: classifyErrorCode(err) };
  }
}

export function checkLiveness(): { status: 'ok'; timestamp: string } {
  return { status: 'ok', timestamp: new Date().toISOString() };
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const ttl = env.HEALTH.CACHE_TTL_MS;

  const [database, pgvector, embeddingServer, reranker, gemini] = await Promise.all([
    cached('database', ttl, checkDatabase),
    cached('pgvector', ttl, checkPgvector),
    cached('embeddingServer', ttl, () => checkHttpReachable(LOCAL_EMBED_URL)),
    cached('reranker', ttl, () => checkHttpReachable(LOCAL_RERANK_URL)),
    cached('gemini', ttl, checkGemini),
  ]);

  const components = { database, pgvector, embeddingServer, reranker, gemini };

  const anyRequiredUnhealthy = REQUIRED_COMPONENTS.some(name => components[name].status === 'unhealthy');
  const anyDegraded = Object.values(components).some(c => c.status !== 'healthy');

  const status: OverallStatus = anyRequiredUnhealthy ? 'unhealthy' : anyDegraded ? 'degraded' : 'healthy';

  if (status !== 'healthy') {
    logger.warn(`[HEALTH] Readiness=${status} — ${JSON.stringify(Object.fromEntries(Object.entries(components).map(([k, v]) => [k, v.status])))}`);
  }

  return { status, checkedAt: new Date().toISOString(), components };
}
