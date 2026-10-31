/**
 * Offline tests for the OpenAI LLM adapter (llm/providers/openai-llm.provider.ts), against a
 * local mock of the Chat Completions API, plus the startup key check (config/llm-providers.ts).
 * No network, no key, no cost.
 *
 * Usage: npm run test:openai-llm
 */
import http from 'http';
import { AddressInfo } from 'net';
import { createOpenAiLlmProvider, toOpenAiReasoningEffort } from '../llm/providers/openai-llm.provider';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { toJsonSchema } from '../llm/json-schema';
import { assertLlmProvidersConfigured, selectedLlmProviders } from '../config/llm-providers';
import { classifyErrorCode } from '../observability/tracer';
import type { LlmSchema } from '../llm/llm.types';
import { DECOMPOSITION_RESPONSE_SCHEMA } from '../rag/query-processing/decomposition/subquery-decomposition.prompt';
import { ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA } from '../rag/query-processing/adaptive-retrieval/adaptive-retrieval.prompt';
import { GROUNDEDNESS_RESPONSE_SCHEMA } from '../rag/guardrails/output/answer-groundedness.prompt';

const results: { name: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };

const KEY = 'sk-proj-TESTKEY_abc123';

interface Seen { method: string; path: string; body: Record<string, any>; auth: string | undefined }
type Reply = { status?: number; json?: unknown; sse?: string[]; delayMs?: number };
const startMock = async (handler: (req: Seen, n: number) => Reply) => {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}'), auth: req.headers.authorization };
      seen.push(s);
      const out = handler(s, seen.length);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(out.status ?? 200, { 'content-type': out.sse ? 'text/event-stream' : 'application/json' });
        if (out.sse) { for (const l of out.sse) res.write(`data: ${l}\n\n`); res.end(); }
        else res.end(JSON.stringify(out.json ?? {}));
      };
      if (out.delayMs) setTimeout(send, out.delayMs); else send();
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => { server.closeAllConnections?.(); server.close(); } };
};

const sleeps: number[] = [];
const mk = (url: string, key = KEY) => createOpenAiLlmProvider({
  apiKey: () => key, baseUrl: () => url, retry: { baseDelayMs: 1, sleep: async ms => { sleeps.push(ms); } },
});
const completion = (content: string, finish = 'stop', model = 'gpt-6-luna-2026-03-05') =>
  ({ json: { id: 'c1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } });
const apiError = (status: number, message: string, code: string | null, type = 'invalid_request_error') => ({ status, json: { error: { message, type, code, param: null } } });
const rejects = async (p: Promise<unknown>): Promise<Error> => p.then(() => new Error('did not reject'), e => e as Error);

(async () => {
  // 1. resolver + interface
  {
    const p = resolveLlmProvider('openai');
    check('1. resolveLlmProvider("openai") is the OpenAI adapter, with generateStream (the answer path streams) — it threw "Unknown LLM provider" before',
      p.name === 'openai' && typeof p.generateStream === 'function' && typeof p.probe === 'function' && typeof p.assertConfigured === 'function',
      `name=${p.name} stream=${typeof p.generateStream} probe=${typeof p.probe}`);
  }

  // 2. reasoning effort: a cost control, always sent
  {
    const map = (['off', 'minimal', 'low', 'medium', 'high', undefined] as const).map(t => `${t}→${toOpenAiReasoningEffort(t)}`).join(' ');
    check('2. thinking → reasoning_effort: off/minimal/unset → none (never the model default "medium"), low/medium/high pass through',
      map === 'off→none minimal→none low→low medium→medium high→high undefined→none', map);
  }

  // 3. request mapping
  {
    const m = await startMock(() => completion('{"route":"FACT_QUESTION"}'));
    const p = mk(m.url);
    const schema: LlmSchema = { type: 'OBJECT', properties: { route: { type: 'STRING', enum: ['A', 'B'] } }, required: ['route'] };
    await p.generate({ model: 'gpt-6-luna', systemPrompt: 'You route.', userPrompt: 'Hi', temperature: 0, maxOutputTokens: 64, thinking: 'minimal', responseSchema: schema, timeoutMs: 4000 });
    await p.generate({ model: 'gpt-6-luna', userPrompt: 'Answer', thinking: 'low', maxOutputTokens: 8192 });
    const [a, b] = m.seen;
    check('3. Request: POST /chat/completions, Bearer key; system + user messages (system omitted when unset); max_completion_tokens (never max_tokens); reasoning_effort sent; temperature passed; strict json_schema response_format',
      a.method === 'POST' && a.path === '/v1/chat/completions' && a.auth === `Bearer ${KEY}`
        && JSON.stringify(a.body.messages) === '[{"role":"system","content":"You route."},{"role":"user","content":"Hi"}]'
        && a.body.max_completion_tokens === 64 && !('max_tokens' in a.body) && a.body.reasoning_effort === 'none' && a.body.temperature === 0
        && a.body.response_format?.type === 'json_schema' && a.body.response_format.json_schema.strict === true
        && a.body.response_format.json_schema.name === 'response'
        && JSON.stringify(a.body.response_format.json_schema.schema) === '{"type":"object","properties":{"route":{"type":"string","enum":["A","B"]}},"additionalProperties":false,"required":["route"]}'
        && JSON.stringify(b.body.messages) === '[{"role":"user","content":"Answer"}]' && b.body.reasoning_effort === 'low'
        && !('temperature' in b.body) && !('response_format' in b.body) && !('stream' in b.body),
      `a=${JSON.stringify(a.body).slice(0, 220)}… b.effort=${b.body.reasoning_effort}`);
    m.close();
  }

  // 4. strict structured output: every property required, every object closed
  {
    const closed = (s: any): boolean => s.type !== 'object' && !(Array.isArray(s.type) && s.type[0] === 'object')
      ? (s.items ? closed(s.items) : true)
      : s.additionalProperties === false && JSON.stringify([...(s.required ?? [])].sort()) === JSON.stringify(Object.keys(s.properties).sort())
        && Object.values(s.properties).every(closed);
    const schemas = [DECOMPOSITION_RESPONSE_SCHEMA, ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA, GROUNDEDNESS_RESPONSE_SCHEMA].map(s => toJsonSchema(s, { strict: true }));
    const adaptive = schemas[1] as any;
    const loose = toJsonSchema(ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA) as any;
    check('4. Strict schema: every object lists ALL its properties in required with additionalProperties:false; a property the schema leaves optional becomes nullable (adaptive retrievalQuery/targetAspect); without strict, required is as written (Groq unchanged)',
      schemas.every(closed) && JSON.stringify(adaptive.properties.retrievalQuery.type) === '["string","null"]'
        && JSON.stringify(adaptive.properties.action.type) === '"string"' && JSON.stringify(loose.required) === '["action","reason"]',
      `adaptive.required=${JSON.stringify(adaptive.required)} retrievalQuery=${JSON.stringify(adaptive.properties.retrievalQuery)}`);
  }

  // 5. response mapping
  {
    const m = await startMock((_r, n) => n === 1 ? completion('Hello there', 'stop') : completion('Cut', 'length'));
    const p = mk(m.url);
    const r1 = await p.generate({ model: 'gpt-6-luna', userPrompt: 'x' });
    const r2 = await p.generate({ model: 'gpt-6-luna', userPrompt: 'x' });
    check('5. Response: raw = message.content, provider openai, model from the response, finish stop→STOP / length→MAX_TOKENS, usage mapped',
      r1.raw === 'Hello there' && r1.provider === 'openai' && r1.model === 'gpt-6-luna-2026-03-05' && r1.finishReason === 'STOP'
        && r1.usage?.inputTokens === 120 && r1.usage?.outputTokens === 30 && r1.usage?.totalTokens === 150 && r2.finishReason === 'MAX_TOKENS',
      `r1=${JSON.stringify(r1)} r2.finish=${r2.finishReason}`);
    m.close();
  }

  // 6. streaming
  {
    const chunk = (content: string | null, finish: string | null = null) => JSON.stringify({ model: 'gpt-6-luna-2026-03-05', choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }] });
    const m = await startMock(() => ({ sse: [
      chunk(''), chunk('Prompts '), chunk('are '), chunk('instructions.'), chunk(null, 'stop'),
      JSON.stringify({ model: 'gpt-6-luna-2026-03-05', choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 } }),
      '[DONE]',
    ] }));
    const pieces: string[] = [];
    const r = await mk(m.url).generateStream!({ model: 'gpt-6-luna', userPrompt: 'x', thinking: 'low' }, t => pieces.push(t));
    const b = m.seen[0].body;
    check('6. Streaming: stream + stream_options.include_usage sent; deltas forwarded in order; usage taken from the final empty-choices chunk (else est_cost_usd stays null); finish STOP',
      b.stream === true && b.stream_options?.include_usage === true && pieces.join('|') === 'Prompts |are |instructions.'
        && r.raw === 'Prompts are instructions.' && r.usage?.inputTokens === 50 && r.usage?.outputTokens === 9 && r.finishReason === 'STOP' && r.model === 'gpt-6-luna-2026-03-05',
      `pieces=${JSON.stringify(pieces)} usage=${JSON.stringify(r.usage)}`);
    m.close();
  }

  // 7. errors
  {
    const m401 = await startMock(() => apiError(401, `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com.`, 'invalid_api_key'));
    const e401 = await rejects(mk(m401.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    const n401 = m401.seen.length; m401.close();
    sleeps.length = 0;
    const mRate = await startMock((_r, n) => n < 3 ? apiError(429, 'Rate limit reached for requests', 'rate_limit_exceeded', 'requests') : completion('ok'));
    const ok = await mk(mRate.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' });
    const nRate = mRate.seen.length; mRate.close();
    const mRate2 = await startMock(() => apiError(429, 'Rate limit reached for requests', 'rate_limit_exceeded', 'requests'));
    const eRate = await rejects(mk(mRate2.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    mRate2.close();
    const mQuota = await startMock(() => apiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota'));
    const eQuota = await rejects(mk(mQuota.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    mQuota.close();
    const m503 = await startMock(() => ({ status: 503, json: { error: { message: 'The server is overloaded', type: 'service_unavailable_error', code: 'server_is_overloaded' } } }));
    const e503 = await rejects(mk(m503.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    const n503 = m503.seen.length; m503.close();
    const m400 = await startMock(() => apiError(400, "Invalid schema for response_format 'response'", 'invalid_json_schema'));
    const e400 = await rejects(mk(m400.url).generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    const n400 = m400.seen.length; m400.close();
    const eNet = await rejects(mk('http://127.0.0.1:9/v1').generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    check('7a. 401 says check OPENAI_API_KEY and never echoes the key (sk-… redacted); not retried',
      /check OPENAI_API_KEY/.test(e401.message) && !e401.message.includes('TESTKEY') && /sk-\*\*\*/.test(e401.message) && n401 === 1, e401.message);
    check('7b. 429 rate limit is retried and recovers; one that persists is a rate limit (RATE_LIMITED), labelled apart from a quota / billing 429 ("retrying will not help")',
      ok.raw === 'ok' && nRate === 3 && /rate limit \(429 rate_limit_exceeded\)/.test(eRate.message) && classifyErrorCode(eRate) === 'RATE_LIMITED'
        && /quota or spend limit reached \(429 insufficient_quota\)/.test(eQuota.message) && /retrying will not help/.test(eQuota.message),
      `rate="${eRate.message.slice(0, 80)}" quota="${eQuota.message.slice(0, 80)}"`);
    check('7c. 5xx is retried (3 attempts) then "service unavailable" (SERVICE_UNAVAILABLE); 400 is not retried; unreachable → SERVICE_UNREACHABLE',
      n503 === 3 && /service unavailable \(503\)/.test(e503.message) && classifyErrorCode(e503) === 'SERVICE_UNAVAILABLE'
        && n400 === 1 && /request rejected \(400 invalid_json_schema\)/.test(e400.message)
        && /not reachable/.test(eNet.message) && classifyErrorCode(eNet) === 'SERVICE_UNREACHABLE',
      `503="${e503.message.slice(0, 60)}" 400="${e400.message.slice(0, 60)}" net="${eNet.message.slice(0, 60)}"`);
  }

  // 8. a timeout is the caller's whole deadline: not retried
  {
    const m = await startMock(() => ({ ...completion('late'), delayMs: 600 }));
    const t0 = Date.now();
    const e = await rejects(mk(m.url).generate({ model: 'gpt-6-luna', userPrompt: 'x', timeoutMs: 150 }));
    const ms = Date.now() - t0;
    check('8. A request that hits timeoutMs fails once as TIMEOUT — never retried (a 4 s router deadline must not become 12 s)',
      m.seen.length === 1 && classifyErrorCode(e) === 'TIMEOUT' && /timeout after 150ms/.test(e.message) && ms < 550,
      `requests=${m.seen.length} in ${ms}ms: ${e.message}`);
    m.close();
  }

  // 9. parameter fallbacks, remembered per model
  {
    const m = await startMock(r => ('temperature' in r.body)
      ? apiError(400, "Unsupported parameter: 'temperature' is not supported with this model's reasoning setting.", 'unsupported_parameter')
      : completion('fine'));
    const p = mk(m.url);
    const a = await p.generate({ model: 'gpt-6-luna', userPrompt: 'x', temperature: 0.3, thinking: 'low' });
    const afterFirst = m.seen.length;
    await p.generate({ model: 'gpt-6-luna', userPrompt: 'y', temperature: 0.3, thinking: 'low' });
    const m2 = await startMock(r => r.body.reasoning_effort === 'none'
      ? apiError(400, "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", 'unsupported_value')
      : completion('fine'));
    const p2 = mk(m2.url);
    await p2.generate({ model: 'gpt-6-astra', userPrompt: 'x', thinking: 'off' });
    await p2.generate({ model: 'gpt-6-astra', userPrompt: 'y', thinking: 'minimal' });
    check('9. A model that rejects temperature (with reasoning on) or reasoning_effort "none" is retried once without it / with "low", and the choice is remembered (later calls send one request)',
      a.raw === 'fine' && afterFirst === 2 && m.seen.length === 3 && !('temperature' in m.seen[2].body)
        && m2.seen.length === 3 && m2.seen[1].body.reasoning_effort === 'low' && m2.seen[2].body.reasoning_effort === 'low',
      `temperature: ${afterFirst} then ${m.seen.length - afterFirst} request(s); effort: ${m2.seen.map(s => s.body.reasoning_effort).join(',')}`);
    m.close(); m2.close();
  }

  // 10. readiness probe
  {
    const m = await startMock(r => r.path === '/v1/models/gpt-6-luna' ? { json: { id: 'gpt-6-luna', object: 'model', owned_by: 'openai' } } : apiError(404, 'The model `gpt-9` does not exist', 'model_not_found'));
    const p = mk(m.url);
    const okProbe = await p.probe!('gpt-6-luna').then(() => 'ok', e => (e as Error).message);
    const missing = await rejects(p.probe!('gpt-9'));
    const calls = m.seen.map(s => `${s.method} ${s.path} ${s.auth === `Bearer ${KEY}`}`);
    m.close();
    const m401 = await startMock(() => apiError(401, 'Incorrect API key provided', 'invalid_api_key'));
    const bad = await rejects(mk(m401.url).probe!('gpt-6-luna'));
    m401.close();
    check('10. probe(model) is ONE GET /models/{model} with the key (no tokens); an unknown model and a rejected key fail clearly',
      okProbe === 'ok' && calls[0] === 'GET /v1/models/gpt-6-luna true' && calls.length === 2
        && /model "gpt-9" is not available/.test(missing.message) && /OPENAI_API_KEY/.test(bad.message),
      `calls=${JSON.stringify(calls)} missing="${missing.message.slice(0, 60)}"`);
  }

  // 11. key check and startup
  {
    const noKey = mk('http://127.0.0.1:9/v1', '');
    let threw = '';
    try { noKey.assertConfigured!(); } catch (e) { threw = (e as Error).message; }
    const sentNothing = await rejects(noKey.generate({ model: 'gpt-6-luna', userPrompt: 'x' }));
    const llm = { OPENAI: { API_KEY: '' }, RAG_ANSWER: { PROVIDER: 'openai' }, QUERY_ROUTER: { PROVIDER: 'openai' }, GREETING: { PROVIDER: 'openai' } };
    const groups = [...selectedLlmProviders(llm).entries()].map(([k, v]) => `${k}:${v.join('+')}`).join(' ');
    const { env } = await import('../config/env');
    const o = env.LLM.OPENAI as { API_KEY: string };
    const savedKey = o.API_KEY;
    o.API_KEY = '';
    let prod = '';
    try { assertLlmProvidersConfigured('production', llm); } catch (e) { prod = (e as Error).message; }
    let dev = 'no throw';
    try { assertLlmProvidersConfigured('development', { RAG_ANSWER: { PROVIDER: 'openai' } }); } catch (e) { dev = (e as Error).message; }
    let typo = '';
    try { assertLlmProvidersConfigured('development', { RAG_ANSWER: { PROVIDER: 'opneai' } }); } catch (e) { typo = (e as Error).message; }
    o.API_KEY = 'sk-present';
    let withKey = 'no throw';
    try { assertLlmProvidersConfigured('production', { RAG_ANSWER: { PROVIDER: 'openai' } }); } catch (e) { withKey = (e as Error).message; }
    o.API_KEY = savedKey;
    check('11. Missing OPENAI_API_KEY: assertConfigured names it and no request is made; at startup it stops a production boot (naming the tasks) and warns in development; a provider typo stops startup anywhere; the OPENAI block is not a task',
      /OPENAI_API_KEY is not set/.test(threw) && /OPENAI_API_KEY is not set/.test(sentNothing.message)
        && groups === 'openai:RAG_ANSWER+QUERY_ROUTER+GREETING'
        && /OPENAI_API_KEY is not set .*used by RAG_ANSWER, QUERY_ROUTER, GREETING/.test(prod) && dev === 'no throw'
        && /Unknown LLM provider "opneai"/.test(typo) && withKey === 'no throw',
      `groups="${groups}" prod="${prod.slice(0, 90)}" typo="${typo.slice(0, 50)}"`);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
