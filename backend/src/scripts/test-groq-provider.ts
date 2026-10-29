/**
 * Offline tests for the Groq provider adapter + rate limiter, against a local mock of Groq's OpenAI-compatible API.
 * No network, no key, no cost. (The real-model run is a separate script: groq-real-check.)
 */
import http from 'http';
import { AddressInfo } from 'net';
import { createGroqProvider, toJsonSchema } from '../llm/providers/groq-llm.provider';
import { GroqRateLimiter, parseGroqDuration } from '../llm/providers/groq-rate-limiter';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { env } from '../config/env';
import type { LlmSchema } from '../llm/llm.types';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };

interface Seen { body: Record<string, any>; auth: string | undefined }
type Handler = (req: Seen, n: number) => { status?: number; headers?: Record<string, string>; json?: unknown; sse?: string[]; text?: string };

const startMock = async (handler: Handler) => {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const s: Seen = { body: JSON.parse(Buffer.concat(chunks).toString() || '{}'), auth: req.headers.authorization };
      seen.push(s);
      const out = handler(s, seen.length);
      res.writeHead(out.status ?? 200, { 'content-type': out.sse ? 'text/event-stream' : 'application/json', ...(out.headers ?? {}) });
      if (out.sse) { for (const l of out.sse) res.write(`data: ${l}\n\n`); res.end(); }
      else res.end(out.text ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`, close: () => server.close() };
};

const ok = (content: string, finish = 'stop', usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) =>
  ({ json: { choices: [{ message: { content }, finish_reason: finish }], usage } });

const mkProvider = (url: string, over: Partial<{ key: string; maxTpm: number; maxRpm: number; budget: number; sleeps: number[] }> = {}) => {
  const sleeps = over.sleeps ?? [];
  let clock = 1_000_000;                                     // fake clock shared by the limiter and the provider's waits
  const advance = async (ms: number) => { sleeps.push(ms); clock += ms; };
  const limiter = new GroqRateLimiter({ maxRpm: over.maxRpm ?? 20, maxTpm: over.maxTpm ?? 7000, runTokenBudget: over.budget ?? 100000 }, () => clock, advance);
  const provider = createGroqProvider({
    apiKey: () => over.key ?? 'gsk_TESTKEY_123', baseUrl: () => url, limiter, maxWaitMs: () => 90_000,
    reasoningEffort: () => 'low', minCompletionTokens: () => 1024, maxTpm: () => over.maxTpm ?? 7000, sleep: advance,
  });
  return { provider, limiter, sleeps };
};

const VERDICT: LlmSchema = {
  type: 'OBJECT',
  properties: { decision: { type: 'STRING', enum: ['VERIFIED', 'REVISE'] }, items: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['decision', 'items'],
};

(async () => {
  // 1. resolver
  {
    const g = resolveLlmProvider('groq'); const gem = resolveLlmProvider('gemini');
    let unknownThrows = false; try { resolveLlmProvider('nope'); } catch { unknownThrows = true; }
    const defaults = [env.LLM.RAG_ANSWER.PROVIDER, env.LLM.ANSWER_VERIFICATION.PROVIDER, env.LLM.GUARDRAIL.PROVIDER, env.LLM.QUERY_ROUTER.PROVIDER, env.LLM.GREETING.PROVIDER];
    check('1. Resolver: groq is available, gemini is preserved, unknown names still fail, defaults are still gemini',
      g.name === 'groq' && gem.name === 'gemini' && unknownThrows && defaults.every(d => d === 'gemini'), `groq=${g.name} gemini=${gem.name} unknownThrows=${unknownThrows} defaultProviders=${defaults.join(',')}`);
  }

  // 2. request shape + response mapping
  {
    const m = await startMock(() => ok('{"decision":"VERIFIED","items":[]}'));
    const { provider } = mkProvider(m.url);
    const r = await provider.generate({ model: 'openai/gpt-oss-120b', systemPrompt: 'SYS', userPrompt: 'USER', temperature: 0, maxOutputTokens: 500, thinkingBudget: 0, responseSchema: VERDICT });
    const b = m.seen[0].body;
    const rf = b.response_format;
    check('2a. Request: model, system+user messages, auth header, reasoning_effort, temperature, JSON-schema response format (lower-case types, closed objects)',
      b.model === 'openai/gpt-oss-120b' && b.messages[0].role === 'system' && b.messages[0].content === 'SYS' && b.messages[1].content === 'USER'
        && m.seen[0].auth === 'Bearer gsk_TESTKEY_123' && b.reasoning_effort === 'low' && b.temperature === 0
        && rf.type === 'json_schema' && rf.json_schema.schema.type === 'object' && rf.json_schema.schema.additionalProperties === false
        && rf.json_schema.schema.properties.decision.type === 'string' && rf.json_schema.schema.properties.items.items.type === 'string' && rf.json_schema.schema.required.length === 2,
      `model=${b.model} effort=${b.reasoning_effort} format=${rf.type} schemaType=${rf.json_schema.schema.type} closed=${rf.json_schema.schema.additionalProperties === false}`);
    check('2b. Completion budget: a small request (500) is raised to the 1024 floor because gpt-oss reasons inside the budget',
      b.max_completion_tokens === 1024, `max_completion_tokens=${b.max_completion_tokens}`);
    check('2c. Response mapping: content → raw, finish_reason stop → STOP, usage mapped, provider=groq',
      r.raw.includes('VERIFIED') && r.finishReason === 'STOP' && r.usage?.totalTokens === 120 && r.usage?.inputTokens === 100 && r.provider === 'groq', `finish=${r.finishReason} usage=${JSON.stringify(r.usage)}`);
    m.close();

    const m2 = await startMock(() => ok('cut off', 'length'));
    const r2 = await mkProvider(m2.url).provider.generate({ model: 'x', userPrompt: 'q', maxOutputTokens: 8192 });
    check('2d. Large requested output is clamped to fit the per-minute ceiling (7000 − prompt − 200 margin); finish_reason length → MAX_TOKENS',
      m2.seen[0].body.max_completion_tokens <= 6800 && m2.seen[0].body.max_completion_tokens >= 1024 && r2.finishReason === 'MAX_TOKENS', `max_completion_tokens=${m2.seen[0].body.max_completion_tokens} finish=${r2.finishReason}`);
    m2.close();
    check('2e. toJsonSchema maps nested LlmSchema correctly', JSON.stringify(toJsonSchema({ type: 'ARRAY', items: { type: 'NUMBER' } })) === '{"type":"array","items":{"type":"number"}}', 'array of number');
  }

  // 3. key handling
  {
    const m = await startMock(() => ok('x'));
    const { provider } = mkProvider(m.url, { key: '' });
    let msg = ''; try { await provider.generate({ model: 'x', userPrompt: 'q' }); } catch (e) { msg = (e as Error).message; }
    check('3a. Missing GROQ_API_KEY → clear error, and no request is sent', /GROQ_API_KEY/.test(msg) && m.seen.length === 0, `message="${msg.slice(0, 80)}" requestsSent=${m.seen.length}`);
    m.close();
    const m2 = await startMock(() => ({ status: 401, json: { error: { message: 'Invalid API Key: Bearer gsk_TESTKEY_123 rejected, key gsk_TESTKEY_123' } } }));
    let msg2 = ''; try { await mkProvider(m2.url).provider.generate({ model: 'x', userPrompt: 'q' }); } catch (e) { msg2 = (e as Error).message; }
    check('3b. API key never appears in an error message (redacted even if the server echoes it)', /401/.test(msg2) && !msg2.includes('TESTKEY_123'), `message="${msg2.slice(0, 120)}"`);
    m2.close();
  }

  // 4. 429 handling
  {
    const m = await startMock((_r, n) => n === 1 ? { status: 429, headers: { 'retry-after': '2' }, json: { error: { message: 'Rate limit reached. Please try again in 1.5s' } } } : ok('after wait'));
    const { provider, sleeps } = mkProvider(m.url);
    const r = await provider.generate({ model: 'x', userPrompt: 'q' });
    check('4a. 429 with a short retry-after is waited out (as instructed by Groq) and the call then succeeds',
      r.raw === 'after wait' && m.seen.length === 2 && sleeps.some(s => s >= 2000 && s < 3000), `requests=${m.seen.length} sleptMs=${JSON.stringify(sleeps)}`);
    m.close();
    const m2 = await startMock(() => ({ status: 429, headers: { 'retry-after': '7200' }, json: { error: { message: 'Rate limit reached for tokens per day (TPD). Please try again in 2h0m0s' } } }));
    const { provider: p2, sleeps: s2 } = mkProvider(m2.url);
    let msg = ''; try { await p2.generate({ model: 'x', userPrompt: 'q' }); } catch (e) { msg = (e as Error).message; }
    check('4b. A daily-limit 429 (retry-after hours) fails immediately and clearly — no sleeping, no hammering',
      /429/.test(msg) && /rate limit/i.test(msg) && m2.seen.length === 1 && s2.length === 0, `requests=${m2.seen.length} sleeps=${s2.length} message="${msg.slice(0, 110)}"`);
    m2.close();
    const m3 = await startMock(() => ({ status: 429, headers: { 'retry-after': '1' }, json: {} }));
    let msg3 = ''; try { await mkProvider(m3.url).provider.generate({ model: 'x', userPrompt: 'q' }); } catch (e) { msg3 = (e as Error).message; }
    check('4c. Persistent 429 stops after 3 retries (bounded)', /429/.test(msg3) && m3.seen.length === 4, `requests=${m3.seen.length}`);
    m3.close();
  }

  // 5. schema fallback
  {
    const m = await startMock((r) => r.body.response_format?.type === 'json_schema'
      ? { status: 400, json: { error: { message: "response_format json_schema is not supported with this model" } } } : ok('{"decision":"VERIFIED","items":[]}'));
    const r = await mkProvider(m.url).provider.generate({ model: 'x', userPrompt: 'q', responseSchema: VERDICT });
    const second = m.seen[1]?.body;
    check('5. json_schema rejected (400) → one retry with json_object and the schema embedded in the system prompt',
      m.seen.length === 2 && second.response_format.type === 'json_object' && /JSON Schema/.test(second.messages[0].content) && r.raw.includes('VERIFIED'), `requests=${m.seen.length} secondFormat=${second?.response_format?.type}`);
    m.close();
  }

  // 6. streaming
  {
    const m = await startMock(() => ({ sse: [
      JSON.stringify({ choices: [{ delta: { reasoning: 'thinking about it…' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
      '[DONE]',
    ] }));
    const pieces: string[] = [];
    const { provider, limiter } = mkProvider(m.url);
    const r = await provider.generateStream!({ model: 'x', userPrompt: 'q' }, p => pieces.push(p));
    check('6. Streaming: only answer text is forwarded (reasoning is not), full text assembled, usage captured and booked',
      pieces.join('') === 'Hello world' && r.raw === 'Hello world' && r.usage?.totalTokens === 60 && m.seen[0].body.stream === true && limiter.tokensUsed === 60,
      `pieces=${JSON.stringify(pieces)} tokensBooked=${limiter.tokensUsed}`);
    m.close();
  }

  // 7. limiter
  {
    let t = 0; const slept: number[] = [];
    const lim = new GroqRateLimiter({ maxRpm: 3, maxTpm: 1000, runTokenBudget: 5000 }, () => t, async ms => { slept.push(ms); t += ms; });
    await lim.acquire(100); await lim.acquire(100); await lim.acquire(100);
    const w4 = lim.waitMs(100);
    await lim.acquire(100);                                   // 4th must wait for the window to slide
    check('7a. Requests/minute ceiling: the 4th request inside a minute waits for the window (60 s), then proceeds', w4 === 60_000 && slept.reduce((a, b) => a + b, 0) === 60_000, `wait=${w4}ms slept=${JSON.stringify(slept)}`);
    t = 0; const lim2 = new GroqRateLimiter({ maxRpm: 100, maxTpm: 1000, runTokenBudget: 5000 }, () => t, async ms => { t += ms; });
    await lim2.acquire(600); t = 20_000;
    check('7b. Tokens/minute ceiling: 600 used + 600 needed (> 1000) waits until the first one leaves the window', lim2.waitMs(600) === 40_000, `wait=${lim2.waitMs(600)}ms`);
    const e = await lim2.acquire(300);
    lim2.settle(e, 120);
    check('7c. settle() replaces the estimate with real usage; process token budget is enforced',
      lim2.tokensUsed === 120 && (() => { try { lim2.assertWithinBudget(10_000); return false; } catch (err) { return /budget exhausted/.test((err as Error).message); } })(), `used=${lim2.tokensUsed}`);
    check('7d. Groq duration strings parse (2m59.56s, 7.66s, 250ms, 1h2m3s, plain seconds)',
      parseGroqDuration('2m59.56s') === 179_560 && parseGroqDuration('7.66s') === 7660 && parseGroqDuration('250ms') === 250 && parseGroqDuration('1h2m3s') === 3_723_000 && parseGroqDuration('30') === 30_000, 'ok');
    const m = await startMock(() => ({ ...ok('x'), headers: { 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '12s', 'x-ratelimit-remaining-requests': '900' } }));
    const { provider, limiter } = mkProvider(m.url);
    await provider.generate({ model: 'x', userPrompt: 'q' });
    check('7e. Groq rate-limit headers tighten the limiter: low remaining-tokens blocks the next call until the reset', limiter.waitMs(10) > 8000 && limiter.waitMs(10) <= 12_000, `next call would wait ${limiter.waitMs(10)}ms`);
    m.close();
  }

  // 8. oversized prompt
  {
    const m = await startMock(() => ok('x'));
    let msg = ''; try { await mkProvider(m.url, { maxTpm: 2000 }).provider.generate({ model: 'x', userPrompt: 'w'.repeat(9000) }); } catch (e) { msg = (e as Error).message; }
    check('8. A prompt too big for the free per-minute ceiling is refused up front with a clear message (no wasted request)', /per-minute|tokens\/minute/.test(msg) && m.seen.length === 0, `message="${msg.slice(0, 100)}" requests=${m.seen.length}`);
    m.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
})();
