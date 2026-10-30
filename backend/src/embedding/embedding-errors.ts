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
