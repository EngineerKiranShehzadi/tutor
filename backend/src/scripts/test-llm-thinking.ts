/**
 * Per-task thinking control, per-task provider/model defaults, and the chat
 * history window. No network, no DB, no key: fetch is stubbed and the
 * request body the OpenAI adapter sends is inspected.
 *
 * Usage: npm run test:llm-thinking
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-key-not-used';

interface Case { label: string; run: () => boolean | Promise<boolean> }
const cases: Case[] = [];

const captured: Record<string, unknown>[] = [];

async function main() {
  const { resolveLlmProvider } = await import('../llm/llm-provider.resolver');
  const { selectHistoryTurns } = await import('../services/chat.service');
  const { env } = await import('../config/env');
  type Thinking = Parameters<typeof import('../llm/providers/openai-llm.provider').toOpenAiReasoningEffort>[0];

  // Nothing leaves the process: every Chat Completions request is answered
  // here, and its body (reasoning_effort is what the model would receive) kept.
  const completion = { model: 'gpt-6-luna', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    captured.push(body);
    if (body.stream) {
      const sse = [{ model: 'gpt-6-luna', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, { model: 'gpt-6-luna', choices: [], usage: completion.usage }]
        .map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const llm = resolveLlmProvider('openai');
  const sent = async (thinking?: Thinking, stream = false) => {
    captured.length = 0;
    const req = { model: env.LLM.RAG_ANSWER.MODEL, userPrompt: 'q', thinking };
    if (stream) await llm.generateStream!(req, () => undefined);
    else await llm.generate(req);
    return captured[0]?.reasoning_effort;
  };

  // ── reaches the provider request ────────────────────────────────
  cases.push({ label: 'thinking reaches the request as reasoning_effort: low/medium/high as named', run: async () =>
    (await sent('low')) === 'low' && (await sent('medium')) === 'medium' && (await sent('high')) === 'high' });
  cases.push({ label: 'off and minimal -> reasoning_effort none (no reasoning tokens billed)', run: async () =>
    (await sent('off')) === 'none' && (await sent('minimal')) === 'none' });
  cases.push({ label: 'thinking unset -> reasoning_effort none, still sent (the model default is never relied on)', run: async () =>
    (await sent(undefined)) === 'none' });
  cases.push({ label: 'streaming request carries reasoning_effort too', run: async () =>
    (await sent('low', true)) === 'low' && captured[0]?.stream === true });

  // ── defaults / env parsing (child process with the vars blanked) ─
  const TASKS = ['RAG_ANSWER', 'ANSWER_VERIFICATION', 'QUERY_ROUTER', 'QUERY_REWRITE', 'GUARDRAIL', 'QUERY_DECOMPOSITION',
    'ADAPTIVE_RETRIEVAL', 'OUTPUT_FORMAT_REPAIR', 'GREETING', 'LECTURE_SUMMARY'];
  const KEYS = ['RAG_ANSWER', 'ANSWER_VERIFICATION', 'QUERY_ROUTER', 'QUERY_REWRITE', 'GUARDRAIL', 'QUERY_DECOMPOSITION',
    'ADAPTIVE_RETRIEVAL', 'OUTPUT_FORMAT_REPAIR', 'GREETING', 'LECTURE_SUMMARY'];
  const readEnv = (overrides: Record<string, string>) => {
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHAT_HISTORY_TURNS: '' };
    for (const t of TASKS) childEnv[`${t}_THINKING`] = '';
    Object.assign(childEnv, overrides);
    const bin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
    const code = `const {env}=require('../config/env');console.log(JSON.stringify({chat:env.CHAT.HISTORY_TURNS,t:{${KEYS.map(k => `${k}:env.LLM.${k}.THINKING`).join(',')}}}))`;
    const r = spawnSync(bin, ['--transpile-only', '-e', code], { cwd: __dirname, env: childEnv, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { chat: number; t: Record<string, string> };
  };
  cases.push({ label: 'defaults: RAG_ANSWER and LECTURE_SUMMARY low, verifier off, all others minimal; history 10', run: () => {
    const o = readEnv({});
    return o.chat === 10 && o.t.RAG_ANSWER === 'low' && o.t.LECTURE_SUMMARY === 'low' && o.t.ANSWER_VERIFICATION === 'off' &&
      ['QUERY_ROUTER', 'QUERY_REWRITE', 'GUARDRAIL', 'QUERY_DECOMPOSITION', 'ADAPTIVE_RETRIEVAL', 'OUTPUT_FORMAT_REPAIR', 'GREETING'].every(k => o.t[k] === 'minimal');
  } });
  cases.push({ label: 'env overrides honored; invalid value falls back to default', run: () => {
    const o = readEnv({ QUERY_ROUTER_THINKING: 'HIGH', RAG_ANSWER_THINKING: 'bogus', CHAT_HISTORY_TURNS: '4' });
    return o.t.QUERY_ROUTER === 'high' && o.t.RAG_ANSWER === 'low' && o.chat === 4;
  } });

  // ── provider / model defaults (child process, no .env, no LLM vars) ─
  // The child gets only what env.ts requires to load, and dotenv is stubbed so
  // backend/.env cannot fill anything in: every *_LLM_PROVIDER, *_LLM_MODEL,
  // RAG_LLM_PROVIDER, RAG_ANSWER_MODEL and RAG_ANSWER_FALLBACK_MODEL is unset.
  cases.push({ label: 'every *_LLM_PROVIDER / *_LLM_MODEL unset (no .env): all ten tasks resolve to provider openai, model gpt-6-luna; answer fallback gpt-6-luna', run: () => {
    const bin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
    const code = `require('dotenv').config = () => ({ parsed: {} });
      const { env } = require('../config/env');
      const { resolveLlmProvider } = require('../llm/llm-provider.resolver');
      const { selectedLlmProviders } = require('../config/llm-providers');
      const tasks = {};
      for (const [k, c] of Object.entries(env.LLM)) if (c && c.PROVIDER !== undefined) tasks[k] = { provider: c.PROVIDER, resolved: resolveLlmProvider(c.PROVIDER).name, model: c.MODEL };
      console.log(JSON.stringify({ tasks, fallback: env.LLM.RAG_ANSWER.FALLBACK_MODEL, selected: [...selectedLlmProviders().keys()], dotenvRead: env.DB.URL !== '' }));`;
    const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'development', DB_PASSWORD: 'unused', JWT_SECRET: 'j'.repeat(40), JWT_REFRESH_SECRET: 'r'.repeat(40) };
    const r = spawnSync(bin, ['--transpile-only', '-e', code], { cwd: __dirname, env: childEnv, encoding: 'utf8' });
    const o = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { tasks?: Record<string, { provider: string; resolved: string; model: string }>; fallback?: string; selected?: string[]; dotenvRead?: boolean };
    const tasks = Object.entries(o.tasks ?? {});
    const ok = tasks.length === TASKS.length && TASKS.every(t => o.tasks?.[t] !== undefined)
      && tasks.every(([, t]) => t.provider === 'openai' && t.resolved === 'openai' && t.model === 'gpt-6-luna')
      && o.fallback === 'gpt-6-luna' && JSON.stringify(o.selected) === '["openai"]' && o.dotenvRead === false;
    if (!ok) console.log(`      child: status=${r.status} ${r.stdout.trim().slice(-400)} ${r.stderr.trim().slice(-300)}`);
    return ok;
  } });

  // ── CHAT_HISTORY_TURNS ──────────────────────────────────────────
  const history = Array.from({ length: 15 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` })) as never[];
  cases.push({ label: 'selectHistoryTurns keeps the last N turns, oldest first', run: () => {
    const r = selectHistoryTurns(history, 3);
    return r.length === 3 && r[0].question === 'q12' && r[2].question === 'q14';
  } });
  cases.push({ label: 'selectHistoryTurns: N larger than history returns all; 0 returns none', run: () =>
    selectHistoryTurns(history, 50).length === 15 && selectHistoryTurns(history, 0).length === 0 });
  cases.push({ label: 'chat.service uses env.CHAT.HISTORY_TURNS (no hard-coded window)', run: () => {
    const src = require('fs').readFileSync(path.join(__dirname, '../services/chat.service.ts'), 'utf8') as string;
    return src.includes('selectHistoryTurns(recentHistory, env.CHAT.HISTORY_TURNS)') && !src.includes('.slice(-10)') && typeof env.CHAT.HISTORY_TURNS === 'number';
  } });

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
