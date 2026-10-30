/**
 * Embedding / rerank provider neutrality + retrieval thresholds from env.
 * No network, no DB: fetch is stubbed; env-dependent cases run in child
 * processes with the variables blanked or set.
 *
 * Usage: npm run test:retrieval-providers
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

interface Case { label: string; run: () => boolean | Promise<boolean> }
const cases: Case[] = [];

const BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
const childJson = (code: string, overrides: Record<string, string>) => {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EMBEDDING_PROVIDER: '', RERANK_PROVIDER: '', VECTOR_SIMILARITY_THRESHOLD: '', RERANK_MIN_SCORE: '',
    ...overrides,
  };
  const r = spawnSync(BIN, ['--transpile-only', '-e', code], { cwd: __dirname, env: childEnv, encoding: 'utf8' });
  return { out: r.stdout.trim().split('\n').pop() ?? '', status: r.status, stderr: r.stderr };
};

const READ = `
const {env}=require('../config/env');
const {resolveEmbeddingProvider}=require('../embedding/embedding-provider.resolver');
const {resolveRerankProvider}=require('../rerank/rerank-provider.resolver');
const e=require('../services/embedding.service');
const r=require('../services/rerank.service');
const v=require('../services/vector-search.service');
console.log(JSON.stringify({
  ep:resolveEmbeddingProvider(env.RETRIEVAL.EMBEDDING_PROVIDER).name,
  rp:resolveRerankProvider(env.RETRIEVAL.RERANK_PROVIDER).name,
  ev:e.EMBEDDING_MODEL_VERSION, rv:r.RERANKER_MODEL_VERSION,
  sim:v.SIMILARITY_THRESHOLD, min:r.DEFAULT_MIN_RERANK_SCORE,
}));`;
type Read = { ep: string; rp: string; ev: string; rv: string; sim: number; min: number };
const readEnv = (o: Record<string, string>) => JSON.parse(childJson(READ, o).out) as Read;

async function main() {
  const { resolveEmbeddingProvider } = await import('../embedding/embedding-provider.resolver');
  const { resolveRerankProvider } = await import('../rerank/rerank-provider.resolver');
  const { EmbeddingUnavailableError } = await import('../embedding/embedding-errors');
  const emb = await import('../services/embedding.service');
  const rr = await import('../services/rerank.service');

  const realFetch = globalThis.fetch;
  const stub = (fn: (url: string, init?: { body?: string }) => Response | Promise<Response>) => {
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => fn(String(url), init)) as typeof fetch;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  // ── defaults ────────────────────────────────────────────────────
  cases.push({ label: 'resolvers return local-http for the default provider names', run: () =>
    resolveEmbeddingProvider('local-http').name === 'local-http' && resolveRerankProvider('local-http').name === 'local-http' });
  cases.push({ label: 'unset/blank env: local-http providers, today\'s exact model versions, 0.55 / 0.5', run: () => {
    const o = readEnv({});
    return o.ep === 'local-http' && o.rp === 'local-http' && o.ev === 'bge-large-en-v1.5:1024' && o.rv === 'bge-reranker-large'
      && o.sim === 0.55 && o.min === 0.5;
  } });
  cases.push({ label: 'unknown provider name is rejected by the resolvers', run: () => {
    let n = 0;
    try { resolveEmbeddingProvider('bogus'); } catch { n++; }
    try { resolveRerankProvider('bogus'); } catch { n++; }
    return n === 2;
  } });
  cases.push({ label: 'EMBEDDING_PROVIDER=bogus fails fast when the embedding service loads', run: () => {
    const r = childJson(READ, { EMBEDDING_PROVIDER: 'bogus' });
    return r.status !== 0 && /Unknown embedding provider "bogus"/.test(r.stderr);
  } });

  // ── thresholds from env ─────────────────────────────────────────
  cases.push({ label: 'VECTOR_SIMILARITY_THRESHOLD and RERANK_MIN_SCORE are read from env', run: () => {
    const o = readEnv({ VECTOR_SIMILARITY_THRESHOLD: '0.7', RERANK_MIN_SCORE: '0.3' });
    return o.sim === 0.7 && o.min === 0.3;
  } });
  cases.push({ label: 'invalid threshold values fall back to the defaults', run: () => {
    const o = readEnv({ VECTOR_SIMILARITY_THRESHOLD: 'abc', RERANK_MIN_SCORE: 'NaN' });
    return o.sim === 0.55 && o.min === 0.5;
  } });
  cases.push({ label: 'dedupeAndSelect default floor follows RERANK_MIN_SCORE', run: () => {
    const code = `const r=require('../services/rerank.service');
      const c=(id,s)=>({id,answer:'a'+id,chunk_index:0,rerankScore:s});
      console.log(JSON.stringify(r.dedupeAndSelect([c(1,0.9),c(2,0.4),c(3,0.2)],5).selected.map(x=>x.id)));`;
    return childJson(code, { RERANK_MIN_SCORE: '0.3' }).out === '[1,2]' && childJson(code, {}).out === '[1]';
  } });

  // ── verifier output cap ─────────────────────────────────────────
  const CAP = `console.log(require('../config/env').env.LLM.ANSWER_VERIFICATION.MAX_OUTPUT_TOKENS)`;
  cases.push({ label: 'ANSWER_VERIFICATION_MAX_OUTPUT_TOKENS: default 500, env honored, invalid/0 fall back', run: () =>
    childJson(CAP, { ANSWER_VERIFICATION_MAX_OUTPUT_TOKENS: '' }).out === '500'
    && childJson(CAP, { ANSWER_VERIFICATION_MAX_OUTPUT_TOKENS: '1500' }).out === '1500'
    && childJson(CAP, { ANSWER_VERIFICATION_MAX_OUTPUT_TOKENS: 'x' }).out === '500'
    && childJson(CAP, { ANSWER_VERIFICATION_MAX_OUTPUT_TOKENS: '0' }).out === '500' });

  // ── local-http adapters behave as before ────────────────────────
  cases.push({ label: 'embedding: 503 and unreachable -> EmbeddingUnavailableError; 500 -> plain error', run: async () => {
    stub(() => json({}, 503));
    const a = await emb.generateEmbedding('q', true).catch(e => e);
    stub(() => { throw new TypeError('fetch failed'); });
    const b = await emb.generateEmbeddingsBatch(['x']).catch(e => e);
    stub(() => json({}, 500));
    const c = await emb.generateEmbedding('q').catch(e => e);
    return a instanceof EmbeddingUnavailableError && b instanceof EmbeddingUnavailableError
      && c instanceof Error && !(c instanceof EmbeddingUnavailableError) && emb.EmbeddingUnavailableError === EmbeddingUnavailableError;
  } });
  cases.push({ label: 'embedding: request bodies, empty batch makes no call, wrong dimensions rejected', run: async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub((url, init) => { calls.push({ url, body: JSON.parse(init?.body ?? '{}') }); 
      return url.endsWith('/embed_batch') ? json({ embeddings: [new Array(1024).fill(0.1)] }) : json({ embedding: [1, 2] }); });
    await emb.generateEmbedding('hello', true);
    const batch = await emb.generateEmbeddingsBatch(['p']);
    const empty = await emb.generateEmbeddingsBatch([]);
    stub(() => json({ embeddings: [[1, 2, 3]] }));
    const bad = await emb.generateEmbeddingsBatch(['p']).catch(e => e as Error) as Error;
    return calls.length === 2 && JSON.stringify(calls[0].body) === '{"text":"hello","is_query":true}'
      && JSON.stringify(calls[1].body) === '{"texts":["p"]}' && batch[0].length === 1024 && empty.length === 0
      && bad instanceof Error && /3-dim vector at index 0; expected 1024/.test(bad.message);
  } });
  cases.push({ label: 'rerank: sends {query, candidates:[{id,text}]}, keeps server order, truncates to topN, attaches scores', run: async () => {
    let sent: unknown;
    stub((_u, init) => { sent = JSON.parse(init?.body ?? '{}'); return json({ results: [{ id: 2, score: 0.9 }, { id: 1, score: 0.6 }, { id: 99, score: 0.5 }] }); });
    const chunks = [{ id: 1, chunk_text: 'one' }, { id: 2, chunk_text: 'two' }] as never[];
    const top = await rr.rerankChunks('q', chunks, 5);
    const top1 = await rr.rerankChunks('q', chunks, 1);
    const none = await rr.rerankChunks('q', []);
    return JSON.stringify(sent) === '{"query":"q","candidates":[{"id":1,"text":"one"},{"id":2,"text":"two"}]}'
      && top.map(c => c.id).join() === '2,1' && top[0].rerankScore === 0.9 && top1.length === 1 && none.length === 0;
  } });
  cases.push({ label: 'rerank: server error and unreachable surface as errors', run: async () => {
    stub(() => json({}, 500));
    const a = await rr.rerankChunks('q', [{ id: 1, chunk_text: 'x' }] as never[]).catch(e => e as Error) as Error;
    stub(() => { throw new TypeError('fetch failed'); });
    const b = await rr.rerankChunks('q', [{ id: 1, chunk_text: 'x' }] as never[]).catch(e => e as Error) as Error;
    return /Rerank server error 500/.test(a.message) && /not reachable/.test(b.message);
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
