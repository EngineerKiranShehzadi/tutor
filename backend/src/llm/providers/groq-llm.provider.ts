import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { LlmProvider } from './llm-provider.interface';
import type { LlmRequest, LlmResponse, LlmSchema } from '../llm.types';
import { GroqRateLimiter, parseGroqDuration } from './groq-rate-limiter';

// TEMPORARY free-tier provider for isolated testing (model: openai/gpt-oss-120b on Groq's OpenAI-compatible API).
// Selected only when a service's *_PROVIDER env is 'groq'; Gemini remains the default and is untouched.
//
// Free-tier discipline (limits for gpt-oss-120b are roughly 30 req/min, 8,000 tokens/min, 200,000 tokens/day):
//  - every call goes through GroqRateLimiter (requests/min + tokens/min sliding window, plus a hard per-process
//    token budget so a test run cannot eat the daily allowance);
//  - max_completion_tokens is clamped so prompt + completion fits the per-minute ceiling (Groq rejects requests whose
//    requested size exceeds it), but never below a floor, because gpt-oss spends part of that budget on reasoning;
//  - a 429 is waited out using retry-after when that is short; a long wait (daily limit) fails immediately and clearly;
//  - Groq's x-ratelimit-* response headers tighten the limiter further;
//  - the API key is read from GROQ_API_KEY and is never logged or put in an error message.

export interface GroqProviderOptions {
  apiKey: () => string;
  baseUrl: () => string;
  limiter: GroqRateLimiter;
  maxWaitMs: () => number;
  reasoningEffort: () => string;
  minCompletionTokens: () => number;
  maxTpm: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const CHARS_PER_TOKEN = 3.2;            // deliberately pessimistic for English text
const MAX_RETRIES_429 = 3;

type JsonSchema = Record<string, unknown>;
type Booking = Awaited<ReturnType<GroqRateLimiter['acquire']>>;
interface Exchange { res: Response; entry: Booking }

// The only place LlmSchema is mapped onto JSON Schema for Groq (lower-case types; objects closed).
export function toJsonSchema(schema: LlmSchema): JsonSchema {
  const typeMap: Record<LlmSchema['type'], string> = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', OBJECT: 'object', ARRAY: 'array' };
  const out: JsonSchema = { type: typeMap[schema.type] };
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.enum !== undefined) out.enum = schema.enum;
  if (schema.items !== undefined) out.items = toJsonSchema(schema.items);
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.additionalProperties = false;
  }
  if (schema.required !== undefined) out.required = schema.required;
  return out;
}

const redact = (s: string): string => s.replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
const estimateTokens = (...parts: (string | undefined)[]) => Math.ceil(parts.reduce((n, p) => n + (p?.length ?? 0), 0) / CHARS_PER_TOKEN);

interface ChatChoice { message?: { content?: string | null }; finish_reason?: string | null }
interface ChatUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

export function createGroqProvider(opts: GroqProviderOptions): LlmProvider {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const doFetch = opts.fetchImpl ?? fetch;
  const limiter = opts.limiter;
  let dailyRequestsExhausted = false;

  const buildBody = (req: LlmRequest, stream: boolean, schemaMode: 'json_schema' | 'json_object'): { body: Record<string, unknown>; estimate: number } => {
    const promptTokens = estimateTokens(req.systemPrompt, req.userPrompt, req.responseSchema ? JSON.stringify(req.responseSchema) : undefined) + 20;
    const room = opts.maxTpm() - promptTokens - 200;
    if (room < 256) {
      throw new Error(
        `Groq free tier: this prompt (~${promptTokens} tokens) leaves no room for an answer within the ${opts.maxTpm()} tokens/minute limit — ` +
        `use fewer/shorter context chunks for the test run`
      );
    }
    const wanted = Math.max(req.maxOutputTokens ?? 2048, opts.minCompletionTokens());
    const completion = Math.max(256, Math.min(wanted, room));

    const messages: { role: string; content: string }[] = [];
    let system = req.systemPrompt ?? '';
    if (req.responseSchema && schemaMode === 'json_object') {
      system += `${system ? '\n\n' : ''}Respond with ONLY a JSON object that matches this JSON Schema:\n${JSON.stringify(toJsonSchema(req.responseSchema))}`;
    }
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: req.userPrompt });

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_completion_tokens: completion,
      reasoning_effort: opts.reasoningEffort(),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.responseSchema) {
      body.response_format = schemaMode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: 'structured_output', strict: false, schema: toJsonSchema(req.responseSchema) } }
        : { type: 'json_object' };
    }
    if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
    return { body, estimate: promptTokens + Math.min(completion, 1500) };
  };

  const absorbHeaders = (h: Headers) => {
    const remTokens = parseInt(h.get('x-ratelimit-remaining-tokens') ?? '', 10);
    const resetTokens = parseGroqDuration(h.get('x-ratelimit-reset-tokens'));
    if (Number.isFinite(remTokens) && remTokens < 600 && resetTokens !== null && resetTokens <= 60_000) limiter.blockFor(resetTokens);
    const remReqs = parseInt(h.get('x-ratelimit-remaining-requests') ?? '', 10);
    if (Number.isFinite(remReqs)) {
      if (remReqs <= 0) dailyRequestsExhausted = true;
      logger.info(`[GROQ] rate-limit headroom: ${Number.isFinite(remTokens) ? remTokens : '?'} tokens (this minute), ${remReqs} requests (today)`);
    }
  };

  // One HTTP exchange with 429/5xx handling. Returns the OK response; throws a clean error otherwise.
  const call = async (req: LlmRequest, stream: boolean, schemaMode: 'json_schema' | 'json_object'): Promise<Exchange> => {
    const key = opts.apiKey();
    if (!key) throw new Error('GROQ_API_KEY is not set — add it to the backend .env (never commit it) to use the groq provider');
    if (dailyRequestsExhausted) throw new Error('Groq 429 rate limit: the daily request allowance is used up (x-ratelimit-remaining-requests = 0) — try again after the daily reset');
    const { body, estimate } = buildBody(req, stream, schemaMode);

    for (let attempt = 0; ; attempt++) {
      const entry = await limiter.acquire(estimate);
      let res: Response;
      try {
        res = await doFetch(`${opts.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
        });
      } catch (err) {
        limiter.settle(entry, 0);
        throw new Error(redact(`Groq request failed: ${(err as Error).message}`));
      }
      absorbHeaders(res.headers);
      if (res.ok) return { res, entry };

      const text = redact((await res.text().catch(() => '')).slice(0, 400));
      limiter.settle(entry, 0);
      if (res.status === 429) {
        const fromHeader = parseGroqDuration(res.headers.get('retry-after'));
        const fromBody = /try again in ([0-9hms.]+)/i.exec(text);
        const waitMs = fromHeader ?? (fromBody ? parseGroqDuration(fromBody[1]) : null) ?? 10_000;
        if (waitMs > opts.maxWaitMs() || attempt >= MAX_RETRIES_429) {
          throw new Error(`Groq 429 rate limit: retry-after ${Math.ceil(waitMs / 1000)}s is beyond the allowed wait (${Math.round(opts.maxWaitMs() / 1000)}s) or retries exhausted — likely the daily/long limit. ${text}`);
        }
        logger.warn(`[GROQ] 429 — waiting ${Math.ceil(waitMs / 1000)}s as instructed by Groq (attempt ${attempt + 1}/${MAX_RETRIES_429})`);
        limiter.blockFor(waitMs + 250);
        await sleep(waitMs + 250);
        continue;
      }
      if (res.status >= 500 && attempt < 1) {
        logger.warn(`[GROQ] ${res.status} from Groq — retrying once`);
        await sleep(1000);
        continue;
      }
      throw new Error(`Groq error ${res.status}: ${text}`);
    }
  };

  const callWithSchemaFallback = async (req: LlmRequest, stream: boolean): Promise<Exchange> => {
    try {
      return await call(req, stream, 'json_schema');
    } catch (err) {
      // Some models reject json_schema response_format: degrade ONCE to json_object with the schema in the prompt.
      if (req.responseSchema && /Groq error 400/.test((err as Error).message) && /response_format|json_schema|schema/i.test((err as Error).message)) {
        logger.warn('[GROQ] json_schema response_format rejected — retrying with json_object + schema in the prompt');
        return call(req, stream, 'json_object');
      }
      throw err;
    }
  };

  const finish = (model: string, content: string, finish: string | null | undefined, usage: ChatUsage | undefined): LlmResponse => ({
    raw: content,
    provider: 'groq',
    model,
    finishReason: finish === 'length' ? 'MAX_TOKENS' : finish === 'stop' ? 'STOP' : (finish ?? undefined) || undefined,
    usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined,
  });

  return {
    name: 'groq',

    async generate(req: LlmRequest): Promise<LlmResponse> {
      const { res, entry } = await callWithSchemaFallback(req, false);
      const json = (await res.json()) as { choices?: ChatChoice[]; usage?: ChatUsage };
      limiter.settle(entry, json.usage?.total_tokens);
      const choice = json.choices?.[0];
      return finish(req.model, choice?.message?.content ?? '', choice?.finish_reason, json.usage);
    },

    async generateStream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse> {
      const { res, entry } = await callWithSchemaFallback(req, true);
      let text = '', finishReason: string | null | undefined, usage: ChatUsage | undefined, buf = '';
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: ChatUsage; x_groq?: { usage?: ChatUsage } };
            const piece = chunk.choices?.[0]?.delta?.content;       // reasoning deltas are separate and never forwarded
            if (piece) { text += piece; onDelta(piece); }
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
            usage = chunk.usage ?? chunk.x_groq?.usage ?? usage;
          } catch { /* ignore a malformed keep-alive line */ }
        }
      }
      limiter.settle(entry, usage?.total_tokens);
      return finish(req.model, text, finishReason, usage);
    },
  };
}

export const groqLimiter = new GroqRateLimiter({ maxRpm: env.GROQ.MAX_RPM, maxTpm: env.GROQ.MAX_TPM, runTokenBudget: env.GROQ.RUN_TOKEN_BUDGET });

export const groqLlmProvider: LlmProvider = createGroqProvider({
  apiKey: () => env.GROQ.API_KEY,
  baseUrl: () => env.GROQ.BASE_URL,
  limiter: groqLimiter,
  maxWaitMs: () => env.GROQ.MAX_WAIT_MS,
  reasoningEffort: () => env.GROQ.REASONING_EFFORT,
  minCompletionTokens: () => env.GROQ.MIN_COMPLETION_TOKENS,
  maxTpm: () => env.GROQ.MAX_TPM,
});
