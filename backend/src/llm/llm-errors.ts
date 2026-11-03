// The error a provider adapter throws when the provider answers a call with
// an error status. `retryable` tells callers that have their own retry loop
// (answer-generation.service.ts) whether trying again later can help, so they
// decide from the flag instead of matching words in the message:
//  - true:  a rate limit or an outage (5xx) that outlasted the adapter's own
//           HTTP retries.
//  - false: everything else — above all a quota / billing / spend-limit 429,
//           which waiting does not clear, and bad keys or rejected requests.
export class LlmProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export const isRetryableLlmError = (err: unknown): boolean =>
  err instanceof LlmProviderError && err.retryable;
