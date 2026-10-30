export interface RerankCandidate {
  id: number;
  text: string;
}

export interface RerankScore {
  id: number;
  score: number;
}

// Every rerank adapter (local-http-rerank.provider.ts, and any future hosted
// one) implements exactly this. Business code never sees a provider's own
// transport or SDK — only this interface.
export interface RerankProvider {
  // Stable identifier used for logs and error messages — e.g. 'local-http'.
  readonly name: string;
  // Identifies which cross-encoder produced a score; recorded in request
  // traces and cache keys, so it must change whenever the model does.
  readonly modelVersion: string;
  // Where a readiness probe should check reachability, for providers that sit
  // behind an endpoint of their own (the local server). Omitted for hosted
  // providers: their readiness is the assertConfigured() check, so a probe
  // never spends tokens.
  readonly healthUrl?: string;
  // Throws a clear error if the provider cannot work as configured (missing
  // API key). Called once at startup, and again before the first request so
  // scripts fail with the same message. Never makes a network call.
  assertConfigured(): void;
  // Scores every candidate against the query and returns the scores best-first.
  // Truncating to top-N and mapping ids back to chunks is the caller's job.
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]>;
}
