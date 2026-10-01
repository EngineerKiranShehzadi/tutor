import type { ChunkSource } from '@/types';

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
  const token = localStorage.getItem('accessToken');

  let res: Response;
  try {
    res = await fetch(`${apiBase}/chat/ask-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new StreamUnavailableError('Could not reach the streaming endpoint');
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
