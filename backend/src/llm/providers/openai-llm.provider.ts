import { AppError } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { NetworkError, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import { toJsonSchema } from '../json-schema';
import type { LlmProvider } from './llm-provider.interface';
import type { LlmRequest, LlmResponse, LlmThinking } from '../llm.types';

// OpenAI Chat Completions — POST {base}/chat/completions.
// Request:  { model, messages[{role,content}], max_completion_tokens?, reasoning_effort?,
//             temperature?, response_format?, stream?, stream_options? }
// Response: { model, choices[{ message: { content }, finish_reason }], usage{prompt_tokens,completion_tokens,total_tokens} }
// Streaming: SSE "data: {choices[{delta:{content}, finish_reason}]}" lines, then (with
// stream_options.include_usage) one chunk with empty choices and the usage, then "data: [DONE]".
//
// Cost controls, both of which matter on a small budget:
//  - reasoning_effort is ALWAYS sent. Left out, the model applies its own default effort,
//    which bills reasoning tokens (at the output rate) on every call, including the small
//    structured calls that need none.
//  - max_completion_tokens (never max_tokens) caps visible AND reasoning tokens together.
// The API key is read from OPENAI_API_KEY and never logged or put in an error message.

export interface OpenAiLlmOptions {
  apiKey: () => string;
  baseUrl: () => string;
  retry?: RetryOptions;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

// The provider-neutral thinking level → reasoning_effort. "minimal" is "no reasoning",
// as on the previous default model (gemini-2.5-flash: minimal = a thinking budget of 0)
// and as llm.types.ts asks of small structured calls; reasoning_effort is sent as "none",
// not "minimal". Unset also means none: the model's own default is never relied on.
const EFFORT: Record<LlmThinking, string> = { off: 'none', minimal: 'none', low: 'low', medium: 'medium', high: 'high' };
export const toOpenAiReasoningEffort = (thinking: LlmThinking | undefined): string => EFFORT[thinking ?? 'off'];

// Quota / billing / spend errors come back as 429 like a rate limit, but waiting does not
// clear them; error.code (or error.type) tells them apart.
const QUOTA_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

export const redactOpenAi = (s: string): string =>
  s.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').replace(/Bearer\s+\S+/gi, 'Bearer ***');

interface OpenAiError { detail: string; code: string | null; type: string | null }
async function readError(res: Response): Promise<OpenAiError> {
  const text = await res.text().catch(() => '');
  try {
    const e = (JSON.parse(text) as { error?: { message?: string; type?: string; code?: string } }).error;
    if (e) return { detail: redactOpenAi(String(e.message ?? text).slice(0, 300)), code: e.code ?? null, type: e.type ?? null };
  } catch { /* not JSON */ }
  return { detail: redactOpenAi(text.slice(0, 300)), code: null, type: null };
}

interface ChatUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: ChatUsage;
}
interface ChatChunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: ChatUsage | null;
  error?: { message?: string };
}

// Same provider-neutral values the Gemini adapter reports (chat code checks 'MAX_TOKENS').
const toFinishReason = (f: string | null | undefined): string | undefined =>
  f === 'length' ? 'MAX_TOKENS' : f === 'stop' ? 'STOP' : (f ?? undefined) || undefined;

export function createOpenAiLlmProvider(opts: OpenAiLlmOptions): LlmProvider {
  const retry: RetryOptions = { maxRetries: 2, retryTimeouts: false, ...opts.retry };
  // A model that turns out to reject a parameter (temperature with reasoning on, or
  // reasoning_effort "none" on a newer family) is remembered, so only the first call
  // pays for the rejected request.
  const noTemperature = new Set<string>();
  const minEffortLow = new Set<string>();

  const assertConfigured = (): void => {
    if (!opts.apiKey()) {
      throw new AppError('An LLM task uses provider "openai" but OPENAI_API_KEY is not set — add it to the backend .env (never commit it).', 500);
    }
  };

  const buildBody = (req: LlmRequest, stream: boolean): Record<string, unknown> => {
    let effort = toOpenAiReasoningEffort(req.thinking);
    if (effort === 'none' && minEffortLow.has(req.model)) effort = 'low';
    const messages: { role: string; content: string }[] = [];
    if (req.systemPrompt !== undefined) messages.push({ role: 'system', content: req.systemPrompt });
    messages.push({ role: 'user', content: req.userPrompt });
    const body: Record<string, unknown> = { model: req.model, messages, reasoning_effort: effort };
    if (req.maxOutputTokens !== undefined) body.max_completion_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined && !noTemperature.has(`${req.model}|${effort}`)) body.temperature = req.temperature;
    if (req.responseSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema: toJsonSchema(req.responseSchema, { strict: true }) },
      };
    }
    if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
    return body;
  };

  const fail = (status: number, e: OpenAiError): Error => {
    const code = e.code ?? e.type;
    if (status === 401) return new Error(`OpenAI rejected the API key (401) — check OPENAI_API_KEY: ${e.detail}`);
    if (status === 403) return new Error(`OpenAI refused the request (403) — the key, organization or project has no access: ${e.detail}`);
    if (status === 429 && ((e.code && QUOTA_CODES.has(e.code)) || e.type === 'insufficient_quota')) {
      return new Error(`OpenAI quota or spend limit reached (429 ${code}) — retrying will not help; check billing and limits: ${e.detail}`);
    }
    if (status === 429) return new Error(`OpenAI rate limit (429${code ? ` ${code}` : ''}) persisted after ${retry.maxRetries} retries: ${e.detail}`);
    if (status >= 500) return new Error(`OpenAI service unavailable (${status}) after ${retry.maxRetries} retries: ${e.detail}`);
    return new Error(`OpenAI request rejected (${status}${code ? ` ${code}` : ''}): ${e.detail}`);
  };

  // One request, with the two parameter fallbacks above. Returns the OK response.
  const call = async (req: LlmRequest, stream: boolean): Promise<Response> => {
    assertConfigured();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${opts.baseUrl()}/chat/completions`;
    for (let attempt = 0; ; attempt++) {
      const body = buildBody(req, stream);
      let res: Response;
      try {
        res = await postJsonWithRetry(url, { Authorization: `Bearer ${opts.apiKey()}` }, body, timeoutMs, retry);
      } catch (err) {
        if (err instanceof NetworkError) {
          throw new Error(/timeout|aborted/i.test(err.message)
            ? `OpenAI request timeout after ${timeoutMs}ms`
            : redactOpenAi(`OpenAI not reachable at ${opts.baseUrl()}: ${err.message}`));
        }
        throw err;
      }
      if (res.ok) return res;
      const e = await readError(res);
      if (res.status === 400 && attempt < 2) {
        if ('temperature' in body && /temperature/i.test(e.detail)) {
          noTemperature.add(`${req.model}|${body.reasoning_effort as string}`);
          logger.warn(`[OPENAI] ${req.model} rejected temperature with reasoning_effort=${body.reasoning_effort as string} — sending it without`);
          continue;
        }
        if (body.reasoning_effort === 'none' && /reasoning/i.test(e.detail)) {
          minEffortLow.add(req.model);
          logger.warn(`[OPENAI] ${req.model} rejected reasoning_effort=none — using low`);
          continue;
        }
      }
      throw fail(res.status, e);
    }
  };

  const toResponse = (req: LlmRequest, model: string | undefined, content: string, finish: string | null | undefined, usage: ChatUsage | null | undefined): LlmResponse => ({
    raw: content,
    provider: 'openai',
    model: model ?? req.model,
    finishReason: toFinishReason(finish),
    usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined,
  });

  return {
    name: 'openai',
    assertConfigured,

    // GET /models/{model}: runs no model, so it spends no tokens; proves the key
    // works, the API is reachable and this model is available to the key.
    async probe(model: string): Promise<void> {
      assertConfigured();
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl()}/models/${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${opts.apiKey()}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(redactOpenAi(`OpenAI not reachable at ${opts.baseUrl()}: ${(err as Error).message}`));
      }
      if (res.ok) { await res.arrayBuffer().catch(() => undefined); return; }
      const e = await readError(res);
      if (res.status === 404) throw new Error(`OpenAI model "${model}" is not available to this key (404): ${e.detail}`);
      throw fail(res.status, e);
    },

    async generate(req: LlmRequest): Promise<LlmResponse> {
      const res = await call(req, false);
      const json = (await res.json()) as ChatCompletion;
      const choice = json.choices?.[0];
      return toResponse(req, json.model, choice?.message?.content ?? '', choice?.finish_reason, json.usage);
    },

    async generateStream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse> {
      const res = await call(req, true);
      if (!res.body) throw new Error('OpenAI returned no stream body');
      let text = '', finishReason: string | null | undefined, usage: ChatUsage | null | undefined, model: string | undefined, buf = '';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const handle = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') return;
        let chunk: ChatChunk;
        try { chunk = JSON.parse(payload) as ChatChunk; } catch { return; }   // a malformed keep-alive line
        if (chunk.error) throw new Error(redactOpenAi(`OpenAI stream error: ${chunk.error.message ?? 'unknown'}`));
        model = chunk.model ?? model;
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) { text += piece; onDelta(piece); }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            handle(line);
          }
        }
        handle(buf.trim());
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if ((err as Error).name === 'TimeoutError' || /aborted/i.test(msg)) {
          throw new Error(`OpenAI request timeout after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms (while streaming)`);
        }
        throw new Error(redactOpenAi(msg));
      }
      return toResponse(req, model, text, finishReason, usage);
    },
  };
}

export const openAiLlmProvider: LlmProvider = createOpenAiLlmProvider({
  apiKey: () => env.LLM.OPENAI.API_KEY,
  baseUrl: () => env.LLM.OPENAI.BASE_URL,
});
