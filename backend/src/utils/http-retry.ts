// Shared POST-with-backoff for the hosted embedding / rerank adapters.

export interface RetryOptions {
  // Retries after the first attempt (so up to maxRetries + 1 requests).
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Injectable so tests do not really wait.
  sleep?: (ms: number) => Promise<void>;
  // false: a request that hit its own timeout is not retried (an LLM call's
  // timeout is the caller's whole deadline, so a retry would multiply it).
  retryTimeouts?: boolean;
}

// Statuses worth another attempt: rate limited, or a server-side failure.
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

// The request never produced an HTTP response (DNS, refused, reset, timeout).
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Retry-After is not documented by OpenAI or Voyage, but honour it when sent.
const retryAfterMs = (res: Response): number | null => {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
};

// POSTs JSON and returns the final Response — a success, a non-retryable error
// (returned immediately, never retried), or the last retryable error once the
// retries are used up. Throws NetworkError only if every attempt failed to
// reach the server. Classifying the returned status is the caller's job.
export async function postJsonWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = (attempt: number): number =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (1 + Math.random() * 0.25);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'TimeoutError';
      if (attempt >= maxRetries || (timedOut && opts.retryTimeouts === false)) {
        throw new NetworkError((err as Error).message || 'request failed');
      }
      await sleep(backoff(attempt));
      continue;
    }
    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) return res;
    await res.arrayBuffer().catch(() => undefined); // release the connection before waiting
    await sleep(Math.min(maxDelayMs, retryAfterMs(res) ?? backoff(attempt)));
  }
}

// Best-effort message from an error body without ever echoing a credential.
export async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string };
    const msg = typeof j.error === 'string' ? j.error : j.error?.message ?? j.detail ?? j.message;
    if (msg) return String(msg).slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300);
}
