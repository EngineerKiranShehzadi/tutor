// Every embedding adapter (local-http-embedding.provider.ts, and any future
// hosted one) implements exactly this. Business code never sees a provider's
// own transport or SDK — only this interface.
export interface EmbeddingProvider {
  // Stable identifier used for logs and error messages — e.g. 'local-http'.
  readonly name: string;
  // Identifies which model/dimensionality produced a stored vector. Persisted
  // next to every embedding and used to decide whether stored vectors and
  // cached answers are still valid, so it must change whenever the model or
  // its output dimensionality does.
  readonly modelVersion: string;
  readonly dimensions: number;
  // Where a readiness probe should check reachability, for providers that sit
  // behind an HTTP endpoint. Omitted when there is nothing cheap to probe.
  readonly healthUrl?: string;
  // Embeds one text. isQuery must be true for student questions — retrieval
  // models that distinguish queries from indexed passages (BGE) use it.
  // Throws EmbeddingUnavailableError when the backend is down.
  embed(text: string, isQuery: boolean): Promise<number[]>;
  // Embeds indexed passages (never queries). One vector per text, in order.
  // Same error contract as embed().
  embedBatch(texts: string[]): Promise<number[][]>;
}
