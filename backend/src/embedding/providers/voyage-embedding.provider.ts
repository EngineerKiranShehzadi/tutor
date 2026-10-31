import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { NetworkError, errorDetail, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import { VOYAGE_API_BASE, VoyageUnreachableError, looksLikeQuota, probeVoyage } from '../../utils/voyage-api';
import { EMBEDDING_COLUMN_DIMS } from '../embedding-dimensions';
import { EmbeddingQuotaExceededError, EmbeddingRateLimitedError, EmbeddingUnavailableError } from '../embedding-errors';
import type { EmbeddingProvider } from './embedding-provider.interface';

// Voyage AI Embeddings API — POST /v1/embeddings.
// Request:  { input: string | string[], model, input_type?: 'query' | 'document' | null,
//             truncation?, output_dimension?, output_dtype? }
// Response: { object: 'list', data: [{ object: 'embedding', embedding: number[], index }], model, usage: { total_tokens } }
// Documented limits: at most 1,000 inputs per request; 120K tokens summed
// across them for voyage-4-large / voyage-3-large, 320K for voyage-4 /
// voyage-3.5, 1M for the -lite models; 32K-token context per input. The
// current models return 1024 values by default.
//
// Query/passage asymmetry: BGE marks a query with a text prefix; Voyage takes
// it as `input_type` ('query' for a student question, 'document' for a stored
// chunk) and adds its own prompt, so the text itself is sent unchanged.
export const VOYAGE_EMBEDDINGS_URL = `${VOYAGE_API_BASE}/embeddings`;

// Well under the 1,000-input / 120K-token request limits of the strictest
// model, so one big batch from the dataset pipeline is split here, not rejected.
const MAX_INPUTS_PER_REQUEST = 128;
const MAX_CHARS_PER_REQUEST = 200_000; // ≈100K tokens even at 2 chars/token
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 120_000;

export interface VoyageEmbeddingConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  retry?: RetryOptions;
}

interface VoyageEmbeddingResponse {
  data?: { index?: number; embedding?: unknown }[];
}

export function createVoyageEmbeddingProvider(config: VoyageEmbeddingConfig): EmbeddingProvider {
  const { apiKey, model, dimensions } = config;
  const maxRetries = config.retry?.maxRetries ?? 3;

  const assertConfigured = (): void => {
    if (!apiKey) {
      throw new AppError('EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY to be set in your .env.', 500);
    }
    if (dimensions !== EMBEDDING_COLUMN_DIMS) {
      throw new AppError(
        `EMBEDDING_DIMENSIONS=${dimensions} does not match the database vector column (${EMBEDDING_COLUMN_DIMS}). ` +
        `Use ${EMBEDDING_COLUMN_DIMS}; a different width needs a schema migration and a full re-embed.`, 500);
    }
  };

  const fail = (status: number, detail: string): Error => {
    // One status for "slow down" and for a used-up quota; only the first
    // goes away by waiting, so a quota message fails the build at once.
    if (status === 429 && looksLikeQuota(detail)) {
      return new EmbeddingQuotaExceededError(`Voyage embeddings quota or billing limit reached (429) — check the Voyage dashboard: ${detail}`);
    }
    if (status === 429) {
      return new EmbeddingRateLimitedError(`Voyage embeddings rate limit (429) persisted after ${maxRetries} retries: ${detail}`);
    }
    if (status >= 500) {
      return new EmbeddingUnavailableError(`Voyage embeddings service unavailable (${status}) after ${maxRetries} retries: ${detail}`);
    }
    if (status === 401) return new Error(`Voyage rejected the API key (401) — check VOYAGE_API_KEY: ${detail}`);
    if (status === 403) return new Error(`Voyage refused the request (403) — the key or this server's IP address is not allowed: ${detail}`);
    return new Error(`Voyage embeddings error ${status}: ${detail}`);
  };

  // One request: returns one vector per input, in input order.
  const request = async (inputs: string[], inputType: 'query' | 'document', timeoutMs: number): Promise<number[][]> => {
    assertConfigured();
    let res: Response;
    try {
      res = await postJsonWithRetry(
        VOYAGE_EMBEDDINGS_URL,
        { Authorization: `Bearer ${apiKey}` },
        // truncation:false — an input over the context length is an error,
        // never a vector of a silently cut text. output_dimension is left at
        // the model's default (1024 for every current model; fixed-width
        // models reject the field), and the width is checked below.
        { input: inputs, model, input_type: inputType, truncation: false, output_dtype: 'float' },
        timeoutMs,
        config.retry,
      );
    } catch (err) {
      if (err instanceof NetworkError) {
        throw new EmbeddingUnavailableError(`Voyage embeddings not reachable at ${VOYAGE_EMBEDDINGS_URL}: ${err.message}`);
      }
      throw err;
    }
    if (!res.ok) throw fail(res.status, await errorDetail(res));

    const data = ((await res.json()) as VoyageEmbeddingResponse).data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(`Voyage returned ${Array.isArray(data) ? data.length : 'no'} embeddings for ${inputs.length} inputs`);
    }
    // Place each vector by its `index`, so order never depends on array order.
    const out: (number[] | undefined)[] = new Array(inputs.length).fill(undefined);
    for (const item of data) {
      const i = item.index;
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= inputs.length || out[i] !== undefined) {
        throw new Error(`Voyage returned an invalid or duplicate embedding index (${String(i)})`);
      }
      const v = item.embedding;
      if (!Array.isArray(v) || v.length !== EMBEDDING_COLUMN_DIMS) {
        throw new Error(
          `Voyage (${model}) returned a ${Array.isArray(v) ? v.length : typeof v}-dim vector at index ${i}; ` +
          `expected ${EMBEDDING_COLUMN_DIMS} — pick a model whose default output is ${EMBEDDING_COLUMN_DIMS} dims`);
      }
      if (v.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
        throw new Error(`Voyage returned a non-numeric value in the vector at index ${i}`);
      }
      out[i] = v as number[];
    }
    return out as number[][];
  };

  const requireText = (texts: string[]): void => {
    if (texts.some(t => t.trim().length === 0)) throw new Error('Cannot embed an empty text (Voyage rejects empty inputs)');
  };

  return {
    name: 'voyage',
    modelVersion: `voyage:${model}:${dimensions}`,
    dimensions,
    assertConfigured,

    // Readiness: an authenticated call that runs no model (see voyage-api.ts),
    // so it checks the key and reachability without spending tokens.
    async probe(): Promise<void> {
      assertConfigured();
      try {
        await probeVoyage(apiKey);
      } catch (err) {
        if (err instanceof VoyageUnreachableError) throw new EmbeddingUnavailableError(err.message);
        throw err;
      }
    },

    async embed(text: string, isQuery: boolean): Promise<number[]> {
      requireText([text]);
      const [vec] = await request([text], isQuery ? 'query' : 'document', SINGLE_TIMEOUT_MS);
      logger.info(`[EMBEDDING] ✅ Generated ${vec.length}-dim vector via voyage ${model}`);
      return vec;
    },

    // Indexed passages only, so always input_type 'document'.
    async embedBatch(texts: string[]): Promise<number[][]> {
      requireText(texts);
      const all: number[][] = [];
      for (let start = 0; start < texts.length;) {
        let end = start;
        let chars = 0;
        while (end < texts.length && end - start < MAX_INPUTS_PER_REQUEST && (end === start || chars + texts[end].length <= MAX_CHARS_PER_REQUEST)) {
          chars += texts[end].length;
          end++;
        }
        all.push(...await request(texts.slice(start, end), 'document', BATCH_TIMEOUT_MS));
        start = end;
      }
      logger.info(`[EMBEDDING] ✅ Generated ${all.length} ${EMBEDDING_COLUMN_DIMS}-dim vectors via voyage ${model}`);
      return all;
    },
  };
}
