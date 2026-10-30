/**
 * Per-task thinking control + chat history window.
 * No network, no DB, no live Gemini: the @google/genai Models methods are
 * stubbed and the request config they receive is inspected.
 *
 * Usage: npm run test:llm-thinking
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';

interface Case { label: string; run: () => boolean | Promise<boolean> }
const cases: Case[] = [];

type Captured = { model: string; config: Record<string, unknown> };
const captured: Captured[] = [];

async function main() {
  const { geminiLlmProvider } = await import('../llm/providers/gemini-llm.provider');
  const { toGeminiThinkingConfig } = await import('../llm/providers/gemini-thinking');
  const { selectHistoryTurns } = await import('../services/chat.service');
  const { env } = await import('../config/env');

  // The SDK talks to Gemini over fetch: replace it so nothing leaves the
  // process, and record the outgoing request body (generationConfig holds
  // the thinkingConfig the model would receive).
  const fakeBody = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} };
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { generationConfig?: Record<string, unknown> };
    captured.push({ model: String(url), config: body.generationConfig ?? {} });
    const streaming = String(url).includes('streamGenerateContent');
    return new Response(streaming ? `data: ${JSON.stringify(fakeBody)}\n\n` : JSON.stringify(fakeBody), {
      status: 200,
      headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
    });
  }) as typeof fetch;

  const sent = async (model: string, thinking?: Parameters<typeof toGeminiThinkingConfig>[1], stream = false) => {
    captured.length = 0;
    const req = { model, userPrompt: 'q', thinking };
    if (stream) await geminiLlmProvider.generateStream!(req, () => undefined);
    else await geminiLlmProvider.generate(req);
    return captured[0].config.thinkingConfig as Record<string, unknown> | undefined;
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── reaches the provider request ────────────────────────────────
  cases.push({ label: '2.5 model: low -> thinkingBudget 1024 in request', run: async () => eq(await sent('gemini-2.5-flash-lite', 'low'), { thinkingBudget: 1024 }) });
  cases.push({ label: '2.5 model: off and minimal -> thinkingBudget 0', run: async () =>
    eq(await sent('gemini-2.5-flash-lite', 'off'), { thinkingBudget: 0 }) && eq(await sent('gemini-2.5-flash', 'minimal'), { thinkingBudget: 0 }) });
  cases.push({ label: '2.5 Pro cannot be disabled: off -> budget 128', run: async () => eq(await sent('gemini-2.5-pro', 'off'), { thinkingBudget: 128 }) });
  cases.push({ label: '3.8 Flash: low -> thinkingLevel LOW, no thinkingBudget', run: async () => eq(await sent('gemini-3.8-flash', 'low'), { thinkingLevel: 'LOW' }) });
  cases.push({ label: '3.8 Flash: medium/high pass through', run: async () =>
    eq(await sent('gemini-3.8-flash', 'medium'), { thinkingLevel: 'MEDIUM' }) && eq(await sent('gemini-3.8-flash', 'high'), { thinkingLevel: 'HIGH' }) });
  cases.push({ label: '3.8 Flash rejects MINIMAL: off/minimal clamp to LOW', run: async () =>
    eq(await sent('gemini-3.8-flash', 'off'), { thinkingLevel: 'LOW' }) && eq(await sent('gemini-3.8-flash', 'minimal'), { thinkingLevel: 'LOW' }) });
  cases.push({ label: 'earlier 3.x Flash accepts MINIMAL', run: async () => eq(await sent('gemini-3-flash-preview', 'minimal'), { thinkingLevel: 'MINIMAL' }) });
  cases.push({ label: 'streaming request carries thinking too (2.5 and 3.x)', run: async () =>
    eq(await sent('gemini-2.5-flash', 'low', true), { thinkingBudget: 1024 }) && eq(await sent('gemini-3.8-flash', 'low', true), { thinkingLevel: 'LOW' }) });
  cases.push({ label: 'thinking unset or unknown model family -> no thinkingConfig sent', run: async () =>
    (await sent('gemini-2.5-flash')) === undefined && (await sent('gemini-flash-latest', 'low')) === undefined });

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
