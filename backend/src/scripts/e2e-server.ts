/**
 * TEST-ONLY server entry for the browser end-to-end run (backend/e2e/README.md).
 *
 * Everything is the real backend EXCEPT the Gemini calls, which are replaced by
 * a small deterministic stub — because the Gemini API key in this environment is
 * over quota (HTTP 429), and because a stub makes the answers checkable:
 *   - answer generation: returns "According to the lecture: <the Answer: text of
 *     the FIRST retrieved chunk>" — so which dataset version was retrieved is
 *     visible in the answer text itself;
 *   - groundedness verifier: VERIFIED;
 *   - every other schema-based Gemini call (router / injection classifier /
 *     decomposition / rewrite / planner) fails, so the code's own safe defaults apply.
 * Retrieval, reranking, embeddings, answer memory, versions, SQL are all real.
 *
 * E2E_LLM=real disables the stub entirely (real provider calls, e.g. Groq via e2e/groq-env.sh).
 *
 * Refuses to start unless DATABASE_URL is a local test database.
 * E2E_LLM_DELAY_FILE: optional file holding milliseconds to delay each answer
 * (read on every call) so a publish can be made to land mid-request.
 */
import { readFileSync } from 'fs';

const dbUrl = process.env.DATABASE_URL ?? '';
if (!/(localhost|127\.0\.0\.1)/.test(dbUrl) || !/(test|pipe)/i.test(dbUrl.split('/').pop() ?? '')) {
  console.error('e2e-server: refusing to start — DATABASE_URL must be a LOCAL database named *test*/*pipe*.');
  process.exit(2);
}

import { geminiLlmProvider } from '../llm/providers/gemini-llm.provider';
import type { LlmRequest, LlmResponse } from '../llm/llm.types';

const delayMs = (): number => {
  try { return parseInt(readFileSync(process.env.E2E_LLM_DELAY_FILE ?? '/nonexistent', 'utf8').trim(), 10) || 0; } catch { return 0; }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const firstAnswer = (prompt: string): string => {
  const m = prompt.match(/\[Lecture Content\]\n([\s\S]*?)(?=\n\n\[Lecture Content\]|\n(?:Conversation history|Current Student Question:))/);
  const block = m?.[1] ?? '';
  const a = block.match(/Answer: ([\s\S]*?)(?:\nKeywords:|$)/);
  return a ? a[1].trim() : '';
};

const respond = (req: LlmRequest, raw: string): LlmResponse => ({ raw, provider: 'gemini', model: req.model, finishReason: 'STOP' });

if (process.env.E2E_LLM !== 'real') {
  geminiLlmProvider.generate = async (req: LlmRequest): Promise<LlmResponse> => {
    if (req.responseSchema) {
      const props = (req.responseSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if ('decision' in props) {
        return respond(req, JSON.stringify({ decision: 'VERIFIED', unsupportedClaims: [], missingAspects: [], reason: 'e2e stub verifier' }));
      }
      throw new Error('e2e stub: structured Gemini call not available (code falls back to its defaults)');
    }
    await sleep(delayMs());
    const ans = firstAnswer(req.userPrompt);
    if (!ans) return respond(req, 'I could not find this information in this lecture.');
    return respond(req, `According to the lecture: ${ans}`);
  };
  geminiLlmProvider.generateStream = async (req: LlmRequest, onDelta: (t: string) => void): Promise<LlmResponse> => {
    const r = await geminiLlmProvider.generate(req);
    onDelta(r.raw);
    return r;
  };

}

console.log(process.env.E2E_LLM === 'real'
  ? '[e2e-server] REAL LLM calls (no stub) — providers/models come from the environment (see e2e/groq-env.sh)'
  : '[e2e-server] Gemini replaced by a deterministic stub — retrieval/versions/memory are real');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../server');
