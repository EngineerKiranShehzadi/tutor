/**
 * Hosted embedding (OpenAI) and rerank (Voyage) adapters.
 * No network, no database, no API keys: fetch is stubbed and backoff sleeps
 * are injected. Config-dependent cases run in child processes with the
 * variables set or blanked.
 *
 * Usage: npm run test:hosted-providers
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { createOpenAiEmbeddingProvider, OPENAI_EMBEDDINGS_URL } from '../embedding/providers/openai-embedding.provider';
import { createVoyageRerankProvider, VOYAGE_RERANK_URL } from '../rerank/providers/voyage-rerank.provider';
import { VOYAGE_PROBE_URL } from '../utils/voyage-api';
import { EmbeddingUnavailableError, EmbeddingRateLimitedError, EmbeddingQuotaExceededError } from '../embedding/embedding-errors';
import { checkProviderHealth } from '../observability/health.service';

interface Case { label: string; run: () => boolean | Promise<boolean> }
const cases: Case[] = [];

const BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
const child = (code: string, overrides: Record<string, string>) => {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EMBEDDING_PROVIDER: '', RERANK_PROVIDER: '', EMBEDDING_MODEL: '', EMBEDDING_DIMENSIONS: '', RERANK_MODEL: '',
    OPENAI_API_KEY: '', VOYAGE_API_KEY: '', ...overrides,
  };
  const r = spawnSync(BIN, ['--transpile-only', '-e', code], { cwd: __dirname, env: childEnv, encoding: 'utf8' });
  return { out: r.stdout.trim().split('\n').pop() ?? '', status: r.status, stderr: r.stderr };
};

const KEY = 'sk-test-SECRET-0123456789';
const vec = (n = 1024, fill = 0.25) => new Array(n).fill(fill);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

interface Sent { url: string; method?: string; headers: Record<string, string>; body: any }
const realFetch = globalThis.fetch;
const sent: Sent[] = [];
const stub = (fn: (call: Sent, n: number) => Response | Promise<Response>) => {
  sent.length = 0;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call: Sent = { url: String(url), method: init?.method, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? 'null') };
    sent.push(call);
    return fn(call, sent.length);
  }) as typeof fetch;
};

const sleeps: number[] = [];
const retry = { maxRetries: 3, baseDelayMs: 10, sleep: async (ms: number) => { sleeps.push(ms); } };
const openai = (over: Partial<Parameters<typeof createOpenAiEmbeddingProvider>[0]> = {}) =>
  createOpenAiEmbeddingProvider({ apiKey: KEY, model: 'text-embedding-3-small', dimensions: 1024, retry, ...over });
const voyage = () => createVoyageRerankProvider({ apiKey: KEY, model: 'rerank-3', retry });
// A response in OpenAI's documented shape; items can be given out of order.
const embResp = (items: { index: number; embedding: number[] }[]) =>
  json({ object: 'list', data: items.map(i => ({ object: 'embedding', ...i })), model: 'text-embedding-3-small', usage: { prompt_tokens: 1, total_tokens: 1 } });
const rejects = async (p: Promise<unknown>): Promise<Error> => p.then(() => new Error('did not reject'), e => e as Error);

async function main() {
  // ── OpenAI embeddings ───────────────────────────────────────────
  cases.push({ label: 'openai: model version is openai:<model>:<dims>', run: () =>
    openai().modelVersion === 'openai:text-embedding-3-small:1024' && openai().name === 'openai' && openai().dimensions === 1024 });
  cases.push({ label: 'openai: request shape — URL, POST, Bearer key, {model,input[],dimensions,encoding_format}', run: async () => {
    stub(() => embResp([{ index: 0, embedding: vec() }]));
    await openai().embed('hello', true);
    const c = sent[0];
    return sent.length === 1 && c.url === OPENAI_EMBEDDINGS_URL && c.url === 'https://api.openai.com/v1/embeddings' && c.method === 'POST'
      && c.headers.Authorization === `Bearer ${KEY}` && c.headers['Content-Type'] === 'application/json'
      && JSON.stringify(c.body) === '{"model":"text-embedding-3-small","input":["hello"],"dimensions":1024,"encoding_format":"float"}';
  } });
  cases.push({ label: 'openai: batch keeps input order even when the response array is shuffled (uses index)', run: async () => {
    stub(() => embResp([{ index: 2, embedding: vec(1024, 3) }, { index: 0, embedding: vec(1024, 1) }, { index: 1, embedding: vec(1024, 2) }]));
    const out = await openai().embedBatch(['a', 'b', 'c']);
    return out.map(v => v[0]).join() === '1,2,3' && JSON.stringify(sent[0].body.input) === '["a","b","c"]';
  } });
  cases.push({ label: 'openai: a large batch is split into several requests and order survives across them', run: async () => {
    stub(call => embResp((call.body.input as string[]).map((t, i) => ({ index: i, embedding: vec(1024, Number(t)) }))));
    const texts = Array.from({ length: 600 }, (_, i) => String(i));
    const out = await openai().embedBatch(texts);
    return sent.length === 3 && out.length === 600 && out.every((v, i) => v[0] === i) && sent.every(c => c.body.input.length <= 256);
  } });
  cases.push({ label: 'openai: every vector must have exactly 1024 values — wrong width fails clearly', run: async () => {
    stub(() => embResp([{ index: 0, embedding: vec(512) }]));
    const e = await rejects(openai().embed('x', false));
    return !(e instanceof EmbeddingUnavailableError) && /512-dim vector at index 0; expected 1024/.test(e.message) && /text-embedding-3-small/.test(e.message);
  } });
  cases.push({ label: 'openai: wrong count, bad/duplicate index, non-numeric value are rejected', run: async () => {
    stub(() => embResp([{ index: 0, embedding: vec() }]));
    const a = await rejects(openai().embedBatch(['a', 'b']));
    stub(() => embResp([{ index: 0, embedding: vec() }, { index: 0, embedding: vec() }]));
    const b = await rejects(openai().embedBatch(['a', 'b']));
    stub(() => embResp([{ index: 0, embedding: vec(1024, NaN as unknown as number) }]));
    // NaN serialises to null in JSON → "non-numeric"
    const c = await rejects(openai().embed('a', false));
    return /1 embeddings for 2 inputs/.test(a.message) && /invalid or duplicate embedding index/.test(b.message) && /non-numeric/.test(c.message);
  } });
  cases.push({ label: 'openai: 429 is retried with backoff and then succeeds', run: async () => {
    sleeps.length = 0;
    stub((_c, n) => n < 3 ? json({ error: { message: 'slow down' } }, 429) : embResp([{ index: 0, embedding: vec() }]));
    const v = await openai().embed('x', false);
    return v.length === 1024 && sent.length === 3 && sleeps.length === 2 && sleeps[1] > sleeps[0];
  } });
  cases.push({ label: 'openai: Retry-After is honoured when sent', run: async () => {
    sleeps.length = 0;
    stub((_c, n) => n === 1 ? json({}, 429, { 'retry-after': '7' }) : embResp([{ index: 0, embedding: vec() }]));
    await openai().embed('x', false);
    return sleeps.length === 1 && sleeps[0] === 7000;
  } });
  cases.push({ label: 'openai: 5xx (500) is retried, then recovers', run: async () => {
    stub((_c, n) => n === 1 ? json({}, 500) : embResp([{ index: 0, embedding: vec() }]));
    return (await openai().embed('x', false)).length === 1024 && sent.length === 2;
  } });
  cases.push({ label: 'openai: 429 that never clears and 502/503/504 end as EmbeddingUnavailableError (pipeline pauses)', run: async () => {
    const out: boolean[] = [];
    for (const status of [429, 502, 503, 504]) {
      stub(() => json({ error: { message: 'busy' } }, status));
      const e = await rejects(openai().embed('x', false));
      out.push(e instanceof EmbeddingUnavailableError && sent.length === 4); // 1 try + 3 retries
    }
    return out.every(Boolean);
  } });
  cases.push({ label: 'openai: unreachable (network error) → retried, then EmbeddingUnavailableError', run: async () => {
    stub(() => { throw new TypeError('fetch failed'); });
    const e = await rejects(openai().embedBatch(['x']));
    return e instanceof EmbeddingUnavailableError && sent.length === 4 && /not reachable/.test(e.message);
  } });
  cases.push({ label: 'openai: persistent 500 is a plain error (not an outage); 400 is not retried', run: async () => {
    stub(() => json({ error: { message: 'boom' } }, 500));
    const a = await rejects(openai().embed('x', false));
    stub(() => json({ error: { message: 'input too long' } }, 400));
    const b = await rejects(openai().embed('x', false));
    return !(a instanceof EmbeddingUnavailableError) && sent.length === 1 && /400/.test(b.message) && /input too long/.test(b.message);
  } });
  cases.push({ label: 'openai: 401 says to check OPENAI_API_KEY and never prints the key', run: async () => {
    stub(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
    const e = await rejects(openai().embed('x', false));
    return /OPENAI_API_KEY/.test(e.message) && !e.message.includes(KEY) && !(e instanceof EmbeddingUnavailableError) && sent.length === 1;
  } });
  cases.push({ label: 'openai: empty text is refused before any request', run: async () => {
    stub(() => embResp([]));
    const e = await rejects(openai().embed('', false));
    return /empty/i.test(e.message) && sent.length === 0;
  } });
  cases.push({ label: 'openai: missing key → clear error naming OPENAI_API_KEY, no request made', run: async () => {
    stub(() => embResp([{ index: 0, embedding: vec() }]));
    const p = openai({ apiKey: '' });
    let threw = '';
    try { p.assertConfigured(); } catch (e) { threw = (e as Error).message; }
    const e = await rejects(p.embed('x', false));
    return /OPENAI_API_KEY/.test(threw) && /OPENAI_API_KEY/.test(e.message) && sent.length === 0;
  } });
  cases.push({ label: 'openai: EMBEDDING_DIMENSIONS other than the 1024 column is rejected', run: () => {
    try { openai({ dimensions: 512 }).assertConfigured(); return false; } catch (e) { return /1024/.test((e as Error).message); }
  } });

  // ── Voyage rerank ───────────────────────────────────────────────
  const cands = [{ id: 11, text: 'alpha' }, { id: 22, text: 'beta' }, { id: 33, text: 'gamma' }];
  const rrResp = (data: { index: number; relevance_score: number }[]) => json({ object: 'list', data, model: 'rerank-3', usage: { total_tokens: 9 } });
  cases.push({ label: 'voyage probe: ONE GET /v1/batches?limit=1 with the key, never a rerank call; 200 and 404 pass, 401/429/5xx/unreachable fail', run: async () => {
    stub(() => json({ object: 'list', data: [], has_more: false }));
    await voyage().probe!();
    const call = sent.map(c => `${c.method ?? 'GET'} ${c.url} ${c.headers.Authorization === `Bearer ${KEY}`}`);
    stub(() => json({ detail: 'Not Found' }, 404));
    const moved = await voyage().probe!().then(() => 'ok', () => 'fail');
    const results: string[] = [];
    for (const status of [401, 429, 503]) {
      stub(() => json({ detail: 'x' }, status));
      results.push(await voyage().probe!().then(() => 'ok', (e: Error) => e.message));
    }
    stub(() => { throw new TypeError('fetch failed'); });
    const unreachable = await rejects(voyage().probe!());
    return call.join() === `GET ${VOYAGE_PROBE_URL} true` && VOYAGE_PROBE_URL === 'https://api.voyageai.com/v1/batches?limit=1'
      && moved === 'ok'
      && /VOYAGE_API_KEY/.test(results[0]) && /429/.test(results[1]) && /service unavailable \(503\)/.test(results[2])
      && /not reachable/.test(unreachable.message);
  } });
  cases.push({ label: 'voyage: model version is voyage:<model>', run: () => voyage().modelVersion === 'voyage:rerank-3' && voyage().name === 'voyage' });
  cases.push({ label: 'voyage: request shape — URL, POST, Bearer key, {query, documents[], model}', run: async () => {
    stub(() => rrResp([{ index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.3 }, { index: 2, relevance_score: 0.2 }]));
    await voyage().rerank('what is x?', cands);
    const c = sent[0];
    return c.url === VOYAGE_RERANK_URL && c.url === 'https://api.voyageai.com/v1/rerank' && c.method === 'POST'
      && c.headers.Authorization === `Bearer ${KEY}`
      && JSON.stringify(c.body) === '{"query":"what is x?","documents":["alpha","beta","gamma"],"model":"rerank-3"}';
  } });
  cases.push({ label: 'voyage: relevance scores are mapped back to chunk ids by document index, best first', run: async () => {
    stub(() => rrResp([{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 0.7 }]));
    const r = await voyage().rerank('q', cands);
    return JSON.stringify(r) === '[{"id":33,"score":0.9},{"id":22,"score":0.7},{"id":11,"score":0.4}]';
  } });
  cases.push({ label: 'voyage: an out-of-order response is re-sorted; bad/duplicate index is rejected; a reply missing a document is rejected (S13)', run: async () => {
    stub(() => rrResp([{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.8 }, { index: 2, relevance_score: 0.5 }]));
    const ok = await voyage().rerank('q', cands);
    stub(() => rrResp([{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.8 }]));
    const short = await rejects(voyage().rerank('q', cands));
    stub(() => rrResp([{ index: 5, relevance_score: 0.1 }]));
    const bad = await rejects(voyage().rerank('q', cands));
    stub(() => rrResp([{ index: 1, relevance_score: 0.1 }, { index: 1, relevance_score: 0.2 }]));
    const dup = await rejects(voyage().rerank('q', cands));
    return ok[0].id === 22 && /invalid or duplicate/.test(bad.message) && /invalid or duplicate/.test(dup.message)
      && /Rerank returned 2 scores for 3 candidates/.test(short.message);
  } });
  cases.push({ label: 'voyage: 429 retried then ok; persistent 503 ends as a clear error after retries', run: async () => {
    stub((_c, n) => n === 1 ? json({ detail: 'rate' }, 429) : rrResp([{ index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.3 }, { index: 2, relevance_score: 0.2 }]));
    const ok = await voyage().rerank('q', cands);
    const n429 = sent.length;
    stub(() => json({ detail: 'busy' }, 503));
    const e = await rejects(voyage().rerank('q', cands));
    return ok.length === 3 && n429 === 2 && sent.length === 4 && /unavailable \(503\)/.test(e.message);
  } });
  cases.push({ label: 'voyage: unreachable → clear error; 401 names VOYAGE_API_KEY and hides the key; 400 not retried', run: async () => {
    stub(() => { throw new TypeError('fetch failed'); });
    const a = await rejects(voyage().rerank('q', cands));
    stub(() => json({ detail: 'Provided API key is invalid.' }, 401));
    const b = await rejects(voyage().rerank('q', cands));
    stub(() => json({ detail: 'bad' }, 400));
    const c = await rejects(voyage().rerank('q', cands));
    return /not reachable/.test(a.message) && /VOYAGE_API_KEY/.test(b.message) && !b.message.includes(KEY) && sent.length === 1 && /400/.test(c.message);
  } });
  cases.push({ label: 'voyage: more than 1000 candidates is refused before any request; missing key → clear error', run: async () => {
    stub(() => rrResp([]));
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: i, text: 't' }));
    const a = await rejects(voyage().rerank('q', many));
    const p = createVoyageRerankProvider({ apiKey: '', model: 'rerank-3', retry });
    const b = await rejects(p.rerank('q', cands));
    return /1000/.test(a.message) && /VOYAGE_API_KEY/.test(b.message) && sent.length === 0;
  } });

  // ── resolver / config / startup / health (child processes) ──────
  const STARTUP_V = `require('../config/retrieval-providers').assertRetrievalProvidersConfigured({checkThresholds:false});console.log('STARTUP_OK')`;
  const VERSIONS = `const e=require('../services/embedding.service');const r=require('../services/rerank.service');
    console.log(JSON.stringify({ev:e.EMBEDDING_MODEL_VERSION,rv:r.RERANKER_MODEL_VERSION}))`;
  cases.push({ label: 'selecting openai/voyage switches the model versions to openai:text-embedding-3-small:1024 / voyage:rerank-3', run: () => {
    const o = JSON.parse(child(VERSIONS, { EMBEDDING_PROVIDER: 'openai', RERANK_PROVIDER: 'voyage' }).out) as { ev: string; rv: string };
    const d = JSON.parse(child(VERSIONS, {}).out) as { ev: string; rv: string };
    return o.ev === 'openai:text-embedding-3-small:1024' && o.rv === 'voyage:rerank-3'
      && d.ev === 'bge-large-en-v1.5:1024' && d.rv === 'bge-reranker-large';
  } });
  cases.push({ label: 'registered providers: embedding openai + local-http, rerank voyage + local-http; the Voyage embedder is gone (EMBEDDING_PROVIDER=voyage stops startup as unknown, even with a key)', run: () => {
    const { resolveEmbeddingProvider } = require('../embedding/embedding-provider.resolver') as typeof import('../embedding/embedding-provider.resolver');
    const { resolveRerankProvider } = require('../rerank/rerank-provider.resolver') as typeof import('../rerank/rerank-provider.resolver');
    const { DEFAULT_EMBEDDING_MODELS } = require('../embedding/embedding-provider.resolver') as typeof import('../embedding/embedding-provider.resolver');
    const resolves = (f: (n: string) => unknown, n: string) => { try { f(n); return true; } catch { return false; } };
    const r = child(STARTUP_V, { EMBEDDING_PROVIDER: 'voyage', RERANK_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k' });
    return resolves(resolveEmbeddingProvider, 'openai') && resolves(resolveEmbeddingProvider, 'local-http') && !resolves(resolveEmbeddingProvider, 'voyage')
      && resolves(resolveRerankProvider, 'voyage') && resolves(resolveRerankProvider, 'local-http') && !resolves(resolveRerankProvider, 'openai')
      && JSON.stringify(DEFAULT_EMBEDDING_MODELS) === '{"openai":"text-embedding-3-small"}'
      && r.status !== 0 && /Unknown embedding provider "voyage"/.test(r.stderr);
  } });
  cases.push({ label: 'EMBEDDING_MODEL / EMBEDDING_DIMENSIONS / RERANK_MODEL come from env', run: () => {
    const o = JSON.parse(child(VERSIONS, { EMBEDDING_PROVIDER: 'openai', EMBEDDING_MODEL: 'text-embedding-3-large', EMBEDDING_DIMENSIONS: '1024', RERANK_PROVIDER: 'voyage', RERANK_MODEL: 'rerank-2.5' }).out) as { ev: string; rv: string };
    return o.ev === 'openai:text-embedding-3-large:1024' && o.rv === 'voyage:rerank-2.5';
  } });
  const STARTUP = `require('../config/retrieval-providers').assertRetrievalProvidersConfigured();console.log('STARTUP_OK')`;
  cases.push({ label: 'startup: default local-http needs no keys', run: () => child(STARTUP, {}).out === 'STARTUP_OK' });
  cases.push({ label: 'startup: EMBEDDING_PROVIDER=openai without OPENAI_API_KEY fails once, clearly', run: () => {
    const r = child(STARTUP, { EMBEDDING_PROVIDER: 'openai' });
    return r.status !== 0 && /requires OPENAI_API_KEY/.test(r.stderr) && !/VOYAGE/.test(r.stderr);
  } });
  cases.push({ label: 'startup: RERANK_PROVIDER=voyage without VOYAGE_API_KEY fails clearly; a key for the OTHER provider is not needed', run: () => {
    const r = child(STARTUP, { RERANK_PROVIDER: 'voyage' });
    const ok = child(STARTUP, { RERANK_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k' });
    return r.status !== 0 && /requires VOYAGE_API_KEY/.test(r.stderr) && ok.out === 'STARTUP_OK';
  } });
  cases.push({ label: 'startup: both hosted providers with keys pass; EMBEDDING_DIMENSIONS=512 is rejected', run: () => {
    const both = { EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'k', RERANK_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k2' };
    const bad = child(STARTUP, { ...both, EMBEDDING_DIMENSIONS: '512' });
    return child(STARTUP, both).out === 'STARTUP_OK' && bad.status !== 0 && /1024/.test(bad.stderr);
  } });
  cases.push({ label: 'server.ts runs the startup check before connecting to the database', run: () => {
    const src = require('fs').readFileSync(path.join(__dirname, '../server.ts'), 'utf8') as string;
    return src.indexOf('assertRetrievalProvidersConfigured()') > 0 && src.indexOf('assertRetrievalProvidersConfigured()') < src.indexOf('await connectDB()');
  } });
  cases.push({ label: 'rerankChunks with the voyage provider: scores mapped to chunks, only top N kept', run: () => {
    const code = `globalThis.fetch=async()=>new Response(JSON.stringify({object:'list',data:[{index:1,relevance_score:0.9},{index:2,relevance_score:0.6},{index:0,relevance_score:0.2}],model:'rerank-3',usage:{total_tokens:1}}));
      require('../services/rerank.service').rerankChunks('q',[{id:1,chunk_text:'a'},{id:2,chunk_text:'b'},{id:3,chunk_text:'c'}],2)
        .then(r=>console.log(JSON.stringify(r.map(c=>[c.id,c.rerankScore]))))`;
    return child(code, { RERANK_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k' }).out === '[[2,0.9],[3,0.6]]';
  } });

  // ── health ──────────────────────────────────────────────────────
  cases.push({ label: 'health: OpenAI embeddings are probed with ONE free GET /v1/models/{model}, the Voyage reranker with ONE GET /v1/batches?limit=1 — never an embeddings/rerank call', run: async () => {
    stub(() => json({ id: 'text-embedding-3-small', object: 'model' }));
    const a = await checkProviderHealth(openai());
    const openaiCalls = sent.map(c => `${c.method ?? 'GET'} ${c.url}`);
    stub(() => json({ object: 'list', data: [] }));
    const b = await checkProviderHealth(voyage());
    const voyageCalls = sent.map(x => `${x.method ?? 'GET'} ${x.url}`);
    return a.status === 'healthy' && b.status === 'healthy'
      && openaiCalls.length === 1 && openaiCalls[0] === 'GET https://api.openai.com/v1/models/text-embedding-3-small'
      && voyageCalls.length === 1 && voyageCalls[0] === `GET ${VOYAGE_PROBE_URL}`;
  } });
  cases.push({ label: 'health: Voyage probe with a rejected key (401) → unhealthy; unreachable → unhealthy SERVICE_UNREACHABLE (was "healthy" from config alone)', run: async () => {
    stub(() => json({ detail: 'Provided API key is invalid.' }, 401));
    const a = await checkProviderHealth(voyage());
    stub(() => { throw new TypeError('fetch failed'); });
    const b = await checkProviderHealth(voyage());
    return a.status === 'unhealthy' && b.status === 'unhealthy' && b.errorCode === 'SERVICE_UNREACHABLE';
  } });
  cases.push({ label: 'health: OpenAI probe failing (bad key 401 / unreachable) → unhealthy', run: async () => {
    stub(() => json({ error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401));
    const a = await checkProviderHealth(openai());
    stub(() => { throw new TypeError('fetch failed'); });
    const b = await checkProviderHealth(openai());
    return a.status === 'unhealthy' && b.status === 'unhealthy' && b.errorCode === 'SERVICE_UNREACHABLE';
  } });
  cases.push({ label: 'openai: 429 insufficient_quota → EmbeddingQuotaExceededError (not an outage); 429 rate_limit_exceeded → EmbeddingRateLimitedError (an outage)', run: async () => {
    stub(() => json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429));
    const q = await rejects(openai({ retry: { ...retry, maxRetries: 0 } }).embed('x', false));
    stub(() => json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 429));
    const r = await rejects(openai({ retry: { ...retry, maxRetries: 0 } }).embed('x', false));
    return q instanceof EmbeddingQuotaExceededError && !(q instanceof EmbeddingUnavailableError) && /quota/.test(q.message)
      && r instanceof EmbeddingRateLimitedError && r instanceof EmbeddingUnavailableError && /rate limit/.test(r.message);
  } });
  cases.push({ label: 'health: a hosted provider without its key is unhealthy NOT_CONFIGURED (still no call)', run: async () => {
    stub(() => { throw new Error('no network'); });
    const a = await checkProviderHealth(openai({ apiKey: '' }));
    return a.status === 'unhealthy' && a.errorCode === 'NOT_CONFIGURED' && sent.length === 0;
  } });

  globalThis.fetch = realFetch;
  let failures = 0;
  for (const c of cases) {
    try {
      if (await c.run()) console.log(`PASS  ${c.label}`);
      else { failures++; console.log(`FAIL  ${c.label}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
