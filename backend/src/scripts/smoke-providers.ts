/**
 * Provider smoke test: proves the CONFIGURED providers answer, with real (tiny) calls.
 *   1. one query embedding         — prints the model version and vector length (expects 1024)
 *   2. one rerank of 3 tiny texts  — prints the scores in returned order
 *   3. one one-line LLM call for each distinct (provider, model) configured across the LLM tasks
 *      — prints model, token usage and the estimated cost from LLM_PRICING_JSON
 * The total estimated spend must stay under $0.01 (a call whose worst case would break that is
 * not made, and counts as a failure). Each provider gets its own PASS/FAIL line with a clear
 * message on a missing key; the exit code is non-zero if any step fails. Never touches the
 * database: nothing here reads or writes it.
 *
 * Usage: npm run smoke:providers
 */
import type { LlmResponse } from '../llm/llm.types';
import type { LlmPrice } from '../config/env';

export const BUDGET_USD = 0.01;
export const LLM_PROMPT = 'Reply with the single word: pong';
export const LLM_MAX_OUTPUT_TOKENS = 512;   // thinking tokens count against this, so keep headroom
const EST_PROMPT_TOKENS = 60;               // generous for a one-line prompt, used only for the worst-case check
const EXPECTED_DIMS = 1024;

export interface LlmTarget { provider: string; model: string; tasks: string[] }

// Distinct (provider, model) pairs across every LLM task, including the RAG answer fallback model.
export function collectLlmTargets(
  llm: Record<string, { PROVIDER?: string; MODEL?: string; FALLBACK_MODEL?: string }>,
): LlmTarget[] {
  const byKey = new Map<string, LlmTarget>();
  const add = (provider: string | undefined, model: string | undefined, task: string): void => {
    if (!provider || !model) return;
    const key = `${provider}\u0000${model}`;
    const t = byKey.get(key) ?? { provider, model, tasks: [] };
    t.tasks.push(task);
    byKey.set(key, t);
  };
  for (const [task, c] of Object.entries(llm)) {
    add(c.PROVIDER, c.MODEL, task);
    add(c.PROVIDER, c.FALLBACK_MODEL, `${task} (fallback)`);
  }
  return [...byKey.values()];
}

export const costUsd = (inputTokens: number, outputTokens: number, price: LlmPrice): number =>
  (inputTokens / 1e6) * price.inputPer1M + (outputTokens / 1e6) * price.outputPer1M;

// Upper bound for one call: a short prompt and the full output cap.
export const worstCaseCostUsd = (price: LlmPrice): number => costUsd(EST_PROMPT_TOKENS, LLM_MAX_OUTPUT_TOKENS, price);

export interface SmokeConfig {
  embeddingProvider: string;
  embeddingVersion: string;
  rerankProvider: string;
  rerankVersion: string;
  targets: LlmTarget[];
  pricing: Record<string, LlmPrice>;
  budgetUsd: number;
}

export interface SmokeDeps {
  assertConfigured(): void;                                             // embedding + rerank keys/settings
  embed(text: string): Promise<number[]>;
  rerank(query: string, texts: string[]): Promise<{ text: string; score: number }[]>;
  llm(target: LlmTarget, prompt: string): Promise<LlmResponse>;
  log(line: string): void;
}

export interface SmokeResult { ok: boolean; failures: string[]; totalCostUsd: number }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runSmoke(cfg: SmokeConfig, deps: SmokeDeps): Promise<SmokeResult> {
  const failures: string[] = [];
  let spent = 0;
  const pass = (what: string, detail: string): void => deps.log(`PASS  ${what.padEnd(34)} ${detail}`);
  const fail = (what: string, detail: string): void => { failures.push(what); deps.log(`FAIL  ${what.padEnd(34)} ${detail}`); };

  deps.log(`Embedding : ${cfg.embeddingVersion}  (provider ${cfg.embeddingProvider})`);
  deps.log(`Reranker  : ${cfg.rerankVersion}  (provider ${cfg.rerankProvider})`);
  deps.log(`LLM models: ${cfg.targets.map(t => `${t.provider}/${t.model}`).join(', ') || '(none)'}`);
  deps.log(`Budget    : estimated spend must stay under $${cfg.budgetUsd}\n`);

  // Keys / settings first, so a missing key is one clear line instead of a failure mid-call.
  let configured = true;
  try { deps.assertConfigured(); } catch (e) { configured = false; fail('embedding/rerank configuration', errMsg(e)); }

  // 1. embedding
  if (configured) {
    const t0 = Date.now();
    try {
      const v = await deps.embed('What is prompt engineering?');
      const ok = Array.isArray(v) && v.length === EXPECTED_DIMS && v.every(x => typeof x === 'number' && Number.isFinite(x));
      const detail = `model=${cfg.embeddingVersion} length=${Array.isArray(v) ? v.length : '?'} (expected ${EXPECTED_DIMS}) ${Date.now() - t0}ms`;
      if (ok) pass('embedding (query)', detail); else fail('embedding (query)', detail);
    } catch (e) { fail('embedding (query)', errMsg(e)); }

    // 2. rerank
    const t1 = Date.now();
    try {
      const texts = ['Paris is the capital of France.', 'Bananas are rich in potassium.', 'The Eiffel Tower is in Paris.'];
      const ranked = await deps.rerank('What is the capital of France?', texts);
      const scores = ranked.map(r => `${r.score.toFixed(4)} "${r.text.slice(0, 28)}"`).join(' | ');
      const sane = ranked.length === 3 && ranked.every(r => Number.isFinite(r.score)) && ranked[0].text !== texts[1];
      const detail = `model=${cfg.rerankVersion} scores in order: ${scores} ${Date.now() - t1}ms`;
      if (sane) pass('rerank (3 texts)', detail);
      else fail('rerank (3 texts)', `${detail} — expected 3 finite scores with the banana text not ranked first`);
    } catch (e) { fail('rerank (3 texts)', errMsg(e)); }
  }

  // 3. one call per distinct LLM model
  for (const target of cfg.targets) {
    const label = `llm ${target.provider}/${target.model}`;
    const price = Object.prototype.hasOwnProperty.call(cfg.pricing, target.model) ? cfg.pricing[target.model] : undefined;
    if (price && spent + worstCaseCostUsd(price) > cfg.budgetUsd) {
      fail(label, `skipped: worst case $${worstCaseCostUsd(price).toFixed(5)} would take the total past $${cfg.budgetUsd} (spent so far $${spent.toFixed(5)})`);
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await deps.llm(target, LLM_PROMPT);
      const inTok = r.usage?.inputTokens;
      const outTok = r.usage?.outputTokens;
      let cost = 'cost n/a (no price for this model in LLM_PRICING_JSON)';
      if (price && inTok !== undefined && outTok !== undefined) {
        const c = costUsd(inTok, outTok, price);
        spent += c;
        cost = `est $${c.toFixed(6)}`;
      } else if (price) {
        cost = 'cost n/a (provider returned no token usage)';
      }
      const detail = `tokens in=${inTok ?? '?'} out=${outTok ?? '?'} ${cost} finish=${r.finishReason ?? '?'} reply="${r.raw.trim().slice(0, 30)}" ${Date.now() - t0}ms · tasks: ${target.tasks.join(', ')}`;
      if (r.raw.trim() === '') {
        fail(label, `${detail} — EMPTY reply; thinking may be using the whole ${LLM_MAX_OUTPUT_TOKENS}-token output cap`);
      } else pass(label, detail);
    } catch (e) { fail(label, errMsg(e)); }
  }

  deps.log(`\nTotal estimated LLM cost: $${spent.toFixed(6)} (limit $${cfg.budgetUsd}); embedding/rerank are a few tokens each and are not metered.`);
  if (spent >= cfg.budgetUsd) { failures.push('budget'); deps.log(`FAIL  total estimated cost $${spent.toFixed(6)} reached the $${cfg.budgetUsd} limit`); }
  deps.log(failures.length === 0 ? 'All provider checks passed.' : `${failures.length} check(s) failed: ${failures.join('; ')}`);
  return { ok: failures.length === 0, failures, totalCostUsd: spent };
}

export async function main(): Promise<void> {
  const { env } = await import('../config/env');
  const { generateEmbedding, EMBEDDING_MODEL_VERSION } = await import('../services/embedding.service');
  const { rerankChunks, RERANKER_MODEL_VERSION } = await import('../services/rerank.service');
  const { resolveLlmProvider } = await import('../llm/llm-provider.resolver');
  const { assertRetrievalProvidersConfigured } = await import('../config/retrieval-providers');

  const cfg: SmokeConfig = {
    embeddingProvider: env.RETRIEVAL.EMBEDDING_PROVIDER, embeddingVersion: EMBEDDING_MODEL_VERSION,
    rerankProvider: env.RETRIEVAL.RERANK_PROVIDER, rerankVersion: RERANKER_MODEL_VERSION,
    targets: collectLlmTargets(env.LLM as unknown as Record<string, { PROVIDER?: string; MODEL?: string; FALLBACK_MODEL?: string }>),
    pricing: env.OBSERVABILITY.LLM_PRICING, budgetUsd: BUDGET_USD,
  };
  const deps: SmokeDeps = {
    assertConfigured: assertRetrievalProvidersConfigured,
    embed: text => generateEmbedding(text, true),
    rerank: async (q, texts) => {
      const chunks = texts.map((t, i) => ({ id: i + 1, chunk_text: t })) as never[];
      const out = await rerankChunks(q, chunks, texts.length);
      return out.map(c => ({ text: (c as { chunk_text: string }).chunk_text, score: c.rerankScore ?? NaN }));
    },
    llm: (t, prompt) => resolveLlmProvider(t.provider).generate({
      model: t.model, userPrompt: prompt, temperature: 0, maxOutputTokens: LLM_MAX_OUTPUT_TOKENS, thinking: 'off', timeoutMs: 30_000,
    }),
    log: line => console.log(line),
  };
  const result = await runSmoke(cfg, deps);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => { console.error(`smoke-providers crashed: ${errMsg(err)}`); process.exit(1); });
}
