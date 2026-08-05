import { createClient, type PhoenixClient } from '@arizeai/phoenix-client';
import { env } from '../../config/env';
import { ObservabilityError, toObservabilityError } from './errors';

// Lazily-created singleton — the client is never constructed on the
// student request path (only admin observability routes import this
// module), and construction itself does no network I/O.
let client: PhoenixClient | null = null;

export function getPhoenixClient(): PhoenixClient {
  if (!client) {
    const headers: Record<string, string> = {};
    if (env.OBSERVABILITY.PHOENIX_API_KEY) {
      headers.Authorization = `Bearer ${env.OBSERVABILITY.PHOENIX_API_KEY}`;
    }
    client = createClient({ options: { baseUrl: env.OBSERVABILITY.PHOENIX_BASE_URL, headers } });
  }
  return client;
}

export function phoenixProject(): { projectName: string } {
  return { projectName: env.OBSERVABILITY.PHOENIX_PROJECT_NAME };
}

export function assertPhoenixEnabled(): void {
  if (!env.OBSERVABILITY.ENABLED || !env.OBSERVABILITY.PHOENIX_ENABLED) {
    throw new ObservabilityError('PHOENIX_DISABLED', 'Observability/Phoenix is disabled in this environment');
  }
}

// Every Phoenix read call in this codebase goes through this — bounds
// latency so a slow/hanging Phoenix instance can never hang an admin
// request indefinitely, and normalizes failures into ObservabilityError.
export async function withPhoenix<T>(fn: () => Promise<T>, timeoutMs = env.OBSERVABILITY.PHOENIX_QUERY_TIMEOUT_MS): Promise<T> {
  assertPhoenixEnabled();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ObservabilityError('PHOENIX_TIMEOUT', `Phoenix query exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    throw toObservabilityError(err);
  } finally {
    clearTimeout(timer!);
  }
}

// Retries a Phoenix read exactly once on a transient failure (timeout /
// unreachable) — never retries on a 4xx-shaped error (bad filter, not
// found), since retrying those can't succeed and only adds latency.
export async function withPhoenixRetry<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  try {
    return await withPhoenix(fn, timeoutMs);
  } catch (err) {
    if (err instanceof ObservabilityError && (err.code === 'PHOENIX_TIMEOUT' || err.code === 'PHOENIX_UNREACHABLE')) {
      return withPhoenix(fn, timeoutMs);
    }
    throw err;
  }
}
