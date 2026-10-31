// Voyage API base URL and the free readiness probe, used by the Voyage rerank
// adapter (rerank/providers/voyage-rerank.provider.ts). Voyage does reranking
// only; embedding is OpenAI.
import { errorDetail } from './http-retry';

export const VOYAGE_API_BASE = 'https://api.voyageai.com/v1';
// GET /v1/batches lists the account's batch jobs: no model runs, so no tokens
// are spent, but the key is checked. Part of the Batch API (public preview).
export const VOYAGE_PROBE_URL = `${VOYAGE_API_BASE}/batches?limit=1`;
const PROBE_TIMEOUT_MS = 3_000;

// The readiness probe. Resolves when the API answered and did not reject the
// key. A 404/405 means the preview endpoint moved, not that Voyage is down: the
// API was reached, so the probe passes (the passive signal from real calls
// still catches a dead key). Throws a message the health classifier maps:
// unreachable/timeout, 401/403, 429, 5xx.
export async function probeVoyage(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(VOYAGE_PROBE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Voyage not reachable at ${VOYAGE_API_BASE}: ${(err as Error).message}`);
  }
  if (res.ok || res.status === 404 || res.status === 405) {
    await res.arrayBuffer().catch(() => undefined);
    return;
  }
  const detail = await errorDetail(res);
  if (res.status === 401 || res.status === 403) throw new Error(`Voyage rejected the API key (${res.status}) — check VOYAGE_API_KEY: ${detail}`);
  if (res.status === 429) throw new Error(`Voyage rate limit or quota exceeded (429): ${detail}`);
  if (res.status >= 500) throw new Error(`Voyage service unavailable (${res.status}): ${detail}`);
  throw new Error(`Voyage probe failed (${res.status}): ${detail}`);
}
