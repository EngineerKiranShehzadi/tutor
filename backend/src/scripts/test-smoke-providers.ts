/**
 * The provider smoke test's logic (smoke-providers.ts): target collection, cost
 * and budget handling, per-provider failure reporting, exit status, and one
 * end-to-end run of the real wiring against a stubbed fetch.
 * No network, no keys, no spend, no database.
 *
 * Usage: npm run test:smoke-providers
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { LlmPrice } from '../config/env';
import {
  BUDGET_USD, LLM_MAX_OUTPUT_TOKENS, collectLlmTargets, costUsd, runSmoke, worstCaseCostUsd,
  type LlmTarget, type SmokeConfig, type SmokeDeps,
} from './smoke-providers';

interface Case { label: string; run: () => boolean | Promise<boolean> }
const cases: Case[] = [];

const T1: LlmTarget = { provider: 'gemini', model: 'm-main', tasks: ['RAG_ANSWER'] };
const T2: LlmTarget = { provider: 'gemini', model: 'm-lite', tasks: ['GREETING'] };
const cfg = (over: Partial<SmokeConfig> = {}): SmokeConfig => ({
  embeddingProvider: 'openai', embeddingVersion: 'openai:text-embedding-3-small:1024',
  rerankProvider: 'voyage', rerankVersion: 'voyage:rerank-3',
  targets: [T1, T2], pricing: { 'm-main': { inputPer1M: 0.75, outputPer1M: 3.75 }, 'm-lite': { inputPer1M: 0.1, outputPer1M: 0.4 } },
  budgetUsd: BUDGET_USD, ...over,
});
const goodRank = async (_q: string, texts: string[]) =>
  [{ text: texts[0], score: 0.91 }, { text: texts[2], score: 0.62 }, { text: texts[1], score: 0.04 }];
const deps = (over: Partial<SmokeDeps> = {}): SmokeDeps & { lines: string[] } => {
  const lines: string[] = [];
  return {
    assertConfigured: () => undefined,
    embed: async () => new Array(1024).fill(0.1),
    rerank: goodRank,
    llm: async () => ({ raw: 'pong', provider: 'gemini', model: 'm', finishReason: 'STOP', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }),
    log: l => { lines.push(l); },
    ...over, lines,
  };
};
const text = (d: { lines: string[] }): string => d.lines.join('\n');

// ── pure helpers ──
cases.push({ label: 'collectLlmTargets: distinct (provider, model) across tasks, fallback model included, tasks listed', run: () => {
  const t = collectLlmTargets({
    RAG_ANSWER: { PROVIDER: 'gemini', MODEL: 'a', FALLBACK_MODEL: 'b' },
    GREETING: { PROVIDER: 'gemini', MODEL: 'a' }, ROUTER: { PROVIDER: 'groq', MODEL: 'a' }, BROKEN: {},
  });
  return t.length === 3 && t[0].model === 'a' && t[0].tasks.join() === 'RAG_ANSWER,GREETING'
    && t[1].model === 'b' && t[1].tasks.join() === 'RAG_ANSWER (fallback)' && t[2].provider === 'groq';
} });
cases.push({ label: 'cost math: tokens / 1M x price; worst case uses the full output cap', run: () => {
  const p: LlmPrice = { inputPer1M: 1, outputPer1M: 10 };
  return Math.abs(costUsd(1_000_000, 100_000, p) - 2) < 1e-12 && Math.abs(worstCaseCostUsd(p) - ((60 + LLM_MAX_OUTPUT_TOKENS * 10) / 1e6)) < 1e-12;
} });

// ── runSmoke ──
cases.push({ label: 'all good: passes, prints versions, vector length, scores in order, per-model tokens and cost, total', run: async () => {
  const d = deps();
  const r = await runSmoke(cfg(), d);
  const t = text(d);
  return r.ok && r.failures.length === 0 && r.totalCostUsd > 0 && r.totalCostUsd < BUDGET_USD
    && /openai:text-embedding-3-small:1024/.test(t) && /length=1024 \(expected 1024\)/.test(t)
    && /0\.9100 "Paris is the capital of Fra.*0\.6200.*0\.0400/.test(t)
    && /llm gemini\/m-main.*tokens in=10 out=20 est \$0\.000/.test(t) && /Total estimated LLM cost: \$0\.0000/.test(t);
} });
cases.push({ label: 'wrong vector length fails the embedding step and the run', run: async () => {
  const d = deps({ embed: async () => new Array(512).fill(0.1) });
  const r = await runSmoke(cfg(), d);
  return !r.ok && /FAIL  embedding \(query\).*length=512 \(expected 1024\)/.test(text(d));
} });
cases.push({ label: 'missing key: one clear line, embedding/rerank not attempted, LLM checks still run, exit not ok', run: async () => {
  let called = 0;
  const d = deps({
    assertConfigured: () => { throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY to be set in your .env.'); },
    embed: async () => { called++; return []; }, rerank: async () => { called++; return []; },
  });
  const r = await runSmoke(cfg(), d);
  return !r.ok && called === 0 && /FAIL  embedding\/rerank configuration\s+EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY/.test(text(d))
    && /PASS  llm gemini\/m-main/.test(text(d));
} });
cases.push({ label: 'an embedding failure does not stop the rerank or the LLM checks; the run fails', run: async () => {
  const d = deps({ embed: async () => { throw new Error('OpenAI rejected the API key (401) — check OPENAI_API_KEY'); } });
  const r = await runSmoke(cfg(), d);
  return !r.ok && r.failures.join() === 'embedding (query)' && /PASS  rerank/.test(text(d)) && /PASS  llm gemini\/m-lite/.test(text(d)) && /check OPENAI_API_KEY/.test(text(d));
} });
cases.push({ label: 'rerank sanity: the irrelevant text ranked first is a failure; so is a non-finite score', run: async () => {
  const bad = deps({ rerank: async (_q, t) => [{ text: t[1], score: 0.9 }, { text: t[0], score: 0.5 }, { text: t[2], score: 0.1 }] });
  const nan = deps({ rerank: async (_q, t) => [{ text: t[0], score: NaN }, { text: t[2], score: 0.5 }, { text: t[1], score: 0.1 }] });
  return !(await runSmoke(cfg(), bad)).ok && !(await runSmoke(cfg(), nan)).ok;
} });
cases.push({ label: 'one LLM model failing is reported by name and the others still run', run: async () => {
  const d = deps({ llm: async t => { if (t.model === 'm-main') throw new Error('GEMINI_API_KEY is not configured.'); return { raw: 'pong', provider: 'gemini', model: t.model, usage: { inputTokens: 5, outputTokens: 5 } }; } });
  const r = await runSmoke(cfg(), d);
  return !r.ok && r.failures.join() === 'llm gemini/m-main' && /FAIL  llm gemini\/m-main\s+GEMINI_API_KEY is not configured/.test(text(d)) && /PASS  llm gemini\/m-lite/.test(text(d));
} });
cases.push({ label: 'empty LLM reply fails with the thinking-cap hint', run: async () => {
  const d = deps({ llm: async () => ({ raw: '', provider: 'gemini', model: 'm', finishReason: 'MAX_TOKENS', usage: { inputTokens: 5, outputTokens: 512 } }) });
  const r = await runSmoke(cfg({ targets: [T1] }), d);
  return !r.ok && /EMPTY reply; thinking may be using the whole 512-token output cap/.test(text(d));
} });
cases.push({ label: 'no price for a model: the call is made and cost is reported as n/a (not guessed)', run: async () => {
  const d = deps();
  const r = await runSmoke(cfg({ pricing: {} }), d);
  return r.ok && r.totalCostUsd === 0 && /cost n\/a \(no price for this model in LLM_PRICING_JSON\)/.test(text(d));
} });
cases.push({ label: 'budget: a call whose worst case would pass $0.01 is NOT made; the run fails and total stays under the limit', run: async () => {
  let calls = 0;
  const expensive: LlmPrice = { inputPer1M: 100, outputPer1M: 12_000 }; // worst case ≈ $6.1 per call
  const d = deps({ llm: async () => { calls++; return { raw: 'pong', provider: 'gemini', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }; } });
  const r = await runSmoke(cfg({ pricing: { 'm-main': expensive, 'm-lite': expensive } }), d);
  return !r.ok && calls === 0 && r.totalCostUsd < BUDGET_USD && /skipped: worst case .* would take the total past \$0\.01/.test(text(d));
} });
cases.push({ label: 'budget: spend accumulates across models — the second call is skipped once the first used the allowance', run: async () => {
  let calls = 0;
  const price: LlmPrice = { inputPer1M: 0, outputPer1M: 12 };            // worst case 512 tokens ≈ $0.0061
  const d = deps({ llm: async () => { calls++; return { raw: 'pong', provider: 'gemini', model: 'm', usage: { inputTokens: 0, outputTokens: 500 } }; } }); // costs $0.006
  const r = await runSmoke(cfg({ pricing: { 'm-main': price, 'm-lite': price } }), d);
  return calls === 1 && !r.ok && r.totalCostUsd < BUDGET_USD && /FAIL  llm gemini\/m-lite\s+skipped/.test(text(d));
} });
cases.push({ label: 'the smoke test never touches the database', run: () => {
  const src = fs.readFileSync(path.join(__dirname, 'smoke-providers.ts'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return !/config\/database|\bquery\s*[(<]|\bpool\b/.test(code);
} });

// ── end to end: the real wiring (env, providers, resolvers) with every network call stubbed ──
cases.push({ label: 'end to end (stubbed fetch): local-http embed + rerank and every configured LLM model pass, exit 0', run: () => {
  const { env } = require('../config/env') as typeof import('../config/env');
  const targets = collectLlmTargets(env.LLM as never);
  const pricing = JSON.stringify(Object.fromEntries(targets.map(t => [t.model, { inputPer1M: 0.5, outputPer1M: 2 }])));
  const code = `
    const gem = {candidates:[{content:{parts:[{text:'pong'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:9,candidatesTokenCount:2,totalTokenCount:11}};
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/embed')) return new Response(JSON.stringify({embedding:new Array(1024).fill(0.2)}));
      if (u.endsWith('/rerank')) { const b = JSON.parse(init.body); return new Response(JSON.stringify({results:[{id:b.candidates[0].id,score:0.9},{id:b.candidates[2].id,score:0.5},{id:b.candidates[1].id,score:0.1}]})); }
      const stream = u.includes('streamGenerateContent');
      return new Response(stream ? 'data: '+JSON.stringify(gem)+'\\n\\n' : JSON.stringify(gem), {status:200,headers:{'content-type':stream?'text/event-stream':'application/json'}});
    };
    require('./smoke-providers').main();`;
  const r = spawnSync(path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node'), ['--transpile-only', '-e', code], {
    cwd: __dirname, encoding: 'utf8',
    env: { ...(process.env as Record<string, string>), EMBEDDING_PROVIDER: '', RERANK_PROVIDER: '', GEMINI_API_KEY: 'test-key-not-used', LLM_PRICING_JSON: pricing },
  });
  const passes = (r.stdout.match(/^PASS /gm) ?? []).length;
  return r.status === 0 && passes === 2 + targets.length && /bge-large-en-v1.5:1024/.test(r.stdout) && /All provider checks passed/.test(r.stdout) && !/FAIL/.test(r.stdout);
} });
cases.push({ label: 'end to end (stubbed fetch): no GEMINI_API_KEY → the LLM line says so and the exit code is non-zero', run: () => {
  const code = `
    globalThis.fetch = async (url) => { const u = String(url);
      if (u.endsWith('/embed')) return new Response(JSON.stringify({embedding:new Array(1024).fill(0.2)}));
      if (u.endsWith('/rerank')) return new Response(JSON.stringify({results:[{id:1,score:0.9},{id:3,score:0.5},{id:2,score:0.1}]}));
      throw new Error('no network in tests'); };
    require('./smoke-providers').main();`;
  const r = spawnSync(path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node'), ['--transpile-only', '-e', code], {
    cwd: __dirname, encoding: 'utf8', env: { ...(process.env as Record<string, string>), EMBEDDING_PROVIDER: '', RERANK_PROVIDER: '', GEMINI_API_KEY: '' },
  });
  return r.status === 1 && /FAIL  llm gemini\/.*GEMINI_API_KEY is not configured/.test(r.stdout) && /PASS  embedding/.test(r.stdout) && /PASS  rerank/.test(r.stdout);
} });

(async () => {
  let failures = 0;
  for (const c of cases) {
    let pass = false;
    try { pass = await c.run(); } catch (err) { console.log(`      threw: ${(err as Error).message}`); }
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
