import { classifyErrorCode } from './tracer';

// Passive health signal from REAL provider calls (embedding, rerank, the
// answer LLM). Readiness applies it on top of each probe: a free probe can
// pass while real calls fail (e.g. a rate-limited or used-up key), and a config
// check alone would report a dead provider as healthy. Costs nothing — it only
// records outcomes of calls already made.
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
  // A failure after a quiet period longer than the window starts a new run:
  // two old failures plus one new one are not "two in a row".
  const prev = signals.get(c);
  const run = prev && now - prev.lastFailureAt <= SIGNAL_WINDOW_MS ? prev.consecutiveFailures : 0;
  signals.set(c, { consecutiveFailures: run + 1, lastFailureAt: now, lastErrorCode: code });
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
