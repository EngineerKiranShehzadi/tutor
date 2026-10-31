import { classifyErrorCode } from './tracer';

// Passive health signal from REAL provider calls (embedding, rerank, the
// answer LLM). Used by the readiness probe for hosted providers that have no
// free endpoint to probe (e.g. Voyage rerank, Groq): a config check alone
// would report a dead provider as healthy. Costs nothing — it only records
// outcomes of calls already made.
//
// Only availability failures count (unreachable, timeout, rate limit/quota,
// 5xx); a bad input is not the provider being down. A success resets it.

export type ProviderComponent = 'embeddingServer' | 'reranker' | 'answerLlm';

const AVAILABILITY_CODES = new Set(['TIMEOUT', 'SERVICE_UNREACHABLE', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'CONNECTION_ERROR']);
// Two failures in a row, the last within this window, mean "down".
export const SIGNAL_FAILURES_FOR_DOWN = 2;
export const SIGNAL_WINDOW_MS = 5 * 60_000;

interface Signal { consecutiveFailures: number; lastFailureAt: number; lastErrorCode: string }
const signals = new Map<ProviderComponent, Signal>();

export function recordProviderSuccess(c: ProviderComponent): void {
  signals.delete(c);
}

export function recordProviderFailure(c: ProviderComponent, err: unknown, now = Date.now()): void {
  const code = classifyErrorCode(err);
  if (!AVAILABILITY_CODES.has(code)) return;
  const prev = signals.get(c);
  signals.set(c, { consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1, lastFailureAt: now, lastErrorCode: code });
}

/** The error code if recent real calls say the provider is down, else null. */
export function providerDownSignal(c: ProviderComponent, now = Date.now()): string | null {
  const s = signals.get(c);
  if (!s || s.consecutiveFailures < SIGNAL_FAILURES_FOR_DOWN || now - s.lastFailureAt > SIGNAL_WINDOW_MS) return null;
  return s.lastErrorCode;
}

/** Tests only. */
export const resetProviderSignals = (): void => signals.clear();

// Wraps a provider call so its outcome feeds the signal.
export async function tracked<T>(c: ProviderComponent, call: () => Promise<T>): Promise<T> {
  try {
    const out = await call();
    recordProviderSuccess(c);
    return out;
  } catch (err) {
    recordProviderFailure(c, err);
    throw err;
  }
}
