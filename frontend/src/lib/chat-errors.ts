import { StreamServerError } from './chat-stream';

// Shown only when the server gave no message of its own (network failure,
// stream dropped before any event, a masked internal error).
export const FALLBACK_REPLY = "I'm having trouble connecting. Please try again in a moment.";

// Server-authored text is always safe to show: the SSE route sends AppError
// messages or a generic string, and formatGraphQLError masks anything
// unexpected as "Internal server error". Returns null when there is nothing
// specific to say, so the caller falls back to FALLBACK_REPLY.
export const serverMessage = (err: unknown): string | null => {
  if (err instanceof StreamServerError) return err.message || null; // includes StreamRateLimitedError
  const gql = (err as { graphQLErrors?: { message?: string }[] } | null)?.graphQLErrors;
  const msg = gql?.[0]?.message;
  return msg && msg !== 'Internal server error' ? msg : null;
};
