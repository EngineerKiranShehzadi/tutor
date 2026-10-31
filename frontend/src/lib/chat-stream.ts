import type { ChunkSource } from '@/types';
import { getAccessToken, refreshAccessToken } from './auth-token';

// Client for POST /chat/ask-stream (Server-Sent Events). EventSource can't
// send a POST body or an Authorization header, so this reads the response
// stream directly with fetch.

export interface AskStreamParams {
  lectureId: number;
  sessionId: number;
  question:  string;
}

export interface AskStreamHandlers {
  // Next piece of the draft answer.
  onDelta: (text: string) => void;
  // The server retried generation — discard the draft shown so far.
  onReset: () => void;
}

export interface AskStreamResult {
  answer:  string;
  sources: ChunkSource[];
}

// Thrown when the stream never produced a usable response (network failure,
// 401/429/5xx before any event). The caller can safely fall back to the
// regular GraphQL mutation, because the server did not answer.
export class StreamUnavailableError extends Error {}

// Thrown when the server reported a failure through an `error` event.
export class StreamServerError extends Error {}

// The per-student question limit was hit (HTTP 429); message is safe to show.
export class StreamRateLimitedError extends StreamServerError {}

interface ParsedEvent { event: string; data: string }

// Splits a buffer into complete SSE events, returning the unfinished tail.
function drainEvents(buffer: string): { events: ParsedEvent[]; rest: string } {
  const events: ParsedEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) continue; // keep-alive comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

export async function streamAsk(
  params: AskStreamParams,
  handlers: AskStreamHandlers,
  signal: AbortSignal
): Promise<AskStreamResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  const send = (token: string | null) => fetch(`${apiBase}/chat/ask-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(params),
    signal,
  });

  let res: Response;
  try {
    res = await send(getAccessToken());
    // Expired access token: refresh once (shared with axios/Apollo) and resend.
    if (res.status === 401) {
      const fresh = await refreshAccessToken();
      if (fresh) res = await send(fresh);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new StreamUnavailableError('Could not reach the streaming endpoint');
  }

  // Per-student question limit: show the server's message. Falling back to the
  // GraphQL mutation would only hit the same limit.
  if (res.status === 429) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new StreamRateLimitedError(body?.message ?? 'Too many questions. Please wait a moment and try again.');
  }

  if (!res.ok || !res.body) {
    throw new StreamUnavailableError(`Streaming endpoint returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = drainEvents(buffer);
      buffer = rest;

      for (const { event, data } of events) {
        received = true;
        const payload = JSON.parse(data);
        if (event === 'delta') handlers.onDelta(payload.text as string);
        else if (event === 'reset') handlers.onReset();
        else if (event === 'final') {
          return { answer: payload.answer as string, sources: (payload.sources ?? []) as ChunkSource[] };
        } else if (event === 'error') {
          throw new StreamServerError(payload.message as string);
        }
      }
    }
  } catch (err) {
    if (err instanceof StreamServerError || (err as Error).name === 'AbortError') throw err;
    // Connection dropped mid-stream. Before any event this is safe to retry
    // via GraphQL; after events it is a real failure.
    if (!received) throw new StreamUnavailableError('Stream interrupted');
    throw new StreamServerError('The connection was interrupted. Please try again.');
  }

  throw received
    ? new StreamServerError('The response ended unexpectedly. Please try again.')
    : new StreamUnavailableError('Empty stream');
}
