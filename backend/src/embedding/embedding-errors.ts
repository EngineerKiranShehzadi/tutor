// Thrown when the embedding backend cannot be reached or reports itself
// unavailable (e.g. HTTP 502/503/504). Callers that must survive an outage
// (the dataset pipeline) catch this class to tell "the service is down — wait
// and retry" apart from "this particular text cannot be embedded". Every
// embedding adapter must throw it for the first case.
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

// A 429 that persisted through the adapter's retries: the provider is
// throttling us. Transient, so it is treated like an outage (the build waits,
// within the dataset pipeline's outage time limit), but reported as a rate
// limit so the admin sees the real cause.
export class EmbeddingRateLimitedError extends EmbeddingUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingRateLimitedError';
  }
}

// The account's quota or billing limit is used up (e.g. OpenAI 429
// `insufficient_quota`). Waiting does not fix it, so this is NOT an outage:
// the dataset build fails at once with a message saying what to do.
export class EmbeddingQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingQuotaExceededError';
  }
}
