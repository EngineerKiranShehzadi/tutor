import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { NetworkError, errorDetail, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import { EMBEDDING_COLUMN_DIMS } from '../embedding-dimensions';
import { EmbeddingUnavailableError } from '../embedding-errors';
import type { EmbeddingProvider } from './embedding-provider.interface';

// OpenAI Embeddings API — POST /v1/embeddings.
// Request:  { model, input: string | string[], dimensions?, encoding_format? }
// Response: { object: 'list', data: [{ object: 'embedding', index, embedding: number[] }], model, usage }
// Documented limits: at most 2048 inputs and 300,000 tokens summed across all
// inputs per request, 8192 tokens per input; `dimensions` is supported by the
// text-embedding-3 models.
export const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

// Well under the 2048-input / 300k-token request limits, so one oversized
// batch from the dataset pipeline is split here instead of rejected.
const MAX_INPUTS_PER_REQUEST = 256;
const MAX_CHARS_PER_REQUEST = 400_000; // ≈100k tokens even at 4 chars/token
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 120_000;

export interface OpenAiEmbeddingConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  retry?: RetryOptions;
}

interface OpenAiEmbeddingResponse {
  data?: { index?: number; embedding?: unknown }[];
}

export function createOpenAiEmbeddingProvider(config: OpenAiEmbeddingConfig): EmbeddingProvider {
  const { apiKey, model, dimensions } = config;
  const maxRetries = config.retry?.maxRetries ?? 3;

  const assertConfigured = (): void => {
    if (!apiKey) {
      throw new AppError('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY to be set in your .env.', 500);
    }
    if (dimensions !== EMBEDDING_COLUMN_DIMS) {
      throw new AppError(
        `EMBEDDING_DIMENSIONS=${dimensions} does not match the database vector column (${EMBEDDING_COLUMN_DIMS}). ` +
        `Use ${EMBEDDING_COLUMN_DIMS}; a different width needs a schema migration and a full re-embed.`, 500);
    }
  };

  const fail = (status: number, detail: string): Error => {
    if (status === 429) {
      return new EmbeddingUnavailableError(`OpenAI embeddings rate limit (429) persisted after ${maxRetries} retries: ${detail}`);
    }
    if (status === 502 || status === 503 || status === 504) {
      return new EmbeddingUnavailableError(`OpenAI embeddings unavailable (${status}) after ${maxRetries} retries: ${detail}`);
    }
    if (status === 401 || status === 403) {
      return new Error(`OpenAI rejected the API key (${status}) — check OPENAI_API_KEY: ${detail}`);
    }
    return new Error(`OpenAI embeddings error ${status}: ${detail}`);
  };

  // One request: returns one vector per input, in input order.
  const request = async (inputs: string[], timeoutMs: number): Promise<number[][]> => {
    assertConfigured();
    let res: Response;
    try {
      res = await postJsonWithRetry(
        OPENAI_EMBEDDINGS_URL,
        { Authorization: `Bearer ${apiKey}` },
        { model, input: inputs, dimensions, encoding_format: 'float' },
        timeoutMs,
        config.retry,
      );
    } catch (err) {
      if (err instanceof NetworkError) {
        throw new EmbeddingUnavailableError(`OpenAI embeddings not reachable at ${OPENAI_EMBEDDINGS_URL}: ${err.message}`);
      }
      throw err;
    }
    if (!res.ok) throw fail(res.status, await errorDetail(res));

    const data = ((await res.json()) as OpenAiEmbeddingResponse).data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(`OpenAI returned ${Array.isArray(data) ? data.length : 'no'} embeddings for ${inputs.length} inputs`);
    }
    // Responses carry an `index` per item; place by it so order never depends on array order.
    const out: (number[] | undefined)[] = new Array(inputs.length).fill(undefined);
    for (const item of data) {
      const i = item.index;
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= inputs.length || out[i] !== undefined) {
        throw new Error(`OpenAI returned an invalid or duplicate embedding index (${String(i)})`);
      }
      const v = item.embedding;
      if (!Array.isArray(v) || v.length !== EMBEDDING_COLUMN_DIMS) {
        throw new Error(
          `OpenAI (${model}, dimensions=${dimensions}) returned a ${Array.isArray(v) ? v.length : typeof v}-dim vector at index ${i}; ` +
          `expected ${EMBEDDING_COLUMN_DIMS}`);
      }
      if (v.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
        throw new Error(`OpenAI returned a non-numeric value in the vector at index ${i}`);
      }
      out[i] = v as number[];
    }
    return out as number[][];
  };

  const requireText = (texts: string[]): void => {
    if (texts.some(t => t.length === 0)) throw new Error('Cannot embed an empty text (OpenAI rejects empty inputs)');
  };

  return {
    name: 'openai',
    modelVersion: `openai:${model}:${dimensions}`,
    dimensions,
    assertConfigured,

    // OpenAI models have no query/passage distinction, so isQuery is unused.
    async embed(text: string, _isQuery: boolean): Promise<number[]> {
      requireText([text]);
      const [vec] = await request([text], SINGLE_TIMEOUT_MS);
      logger.info(`[EMBEDDING] ✅ Generated ${vec.length}-dim vector via openai ${model}`);
      return vec;
    },

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
        all.push(...await request(texts.slice(start, end), BATCH_TIMEOUT_MS));
        start = end;
      }
      logger.info(`[EMBEDDING] ✅ Generated ${all.length} ${EMBEDDING_COLUMN_DIMS}-dim vectors via openai ${model}`);
      return all;
    },
  };
}
