// REAL Groq call sanity check (openai/gpt-oss-120b). Costs a few hundred tokens. Needs GROQ_API_KEY in .env.
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { groqLimiter } from '../llm/providers/groq-llm.provider';
import { GROUNDEDNESS_RESPONSE_SCHEMA } from '../rag/guardrails/output/answer-groundedness.prompt';

const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
(async () => {
  const p = resolveLlmProvider('groq');
  const t0 = Date.now();
  const a = await p.generate({ model: MODEL, userPrompt: 'Reply with exactly one word: pong', temperature: 0, maxOutputTokens: 200 });
  console.log('1 plain      :', JSON.stringify(a.raw), '| finish', a.finishReason, '| usage', JSON.stringify(a.usage), `| ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const v = await p.generate({
    model: MODEL, temperature: 0, maxOutputTokens: 500, thinkingBudget: 0, responseSchema: GROUNDEDNESS_RESPONSE_SCHEMA,
    systemPrompt: 'You verify whether an ANSWER is fully supported by the CONTEXT. Decide VERIFIED, REVISE or INSUFFICIENT_EVIDENCE.',
    userPrompt: 'CONTEXT: Zero-shot prompting means asking the model to do a task with no examples.\nQUESTION: What is zero-shot prompting?\nANSWER: Zero-shot prompting means giving no examples.',
  });
  let parsed: unknown = null; try { parsed = JSON.parse(v.raw); } catch { /* shown below */ }
  console.log('2 structured :', v.raw.slice(0, 200), '| parsed ok:', parsed !== null, '| finish', v.finishReason, `| ${Date.now() - t1}ms`);

  const pieces: string[] = [];
  const t2 = Date.now();
  const s = await p.generateStream!({ model: MODEL, userPrompt: 'Say hello in five words.', temperature: 0.2, maxOutputTokens: 300 }, d => pieces.push(d));
  console.log('3 streaming  :', JSON.stringify(s.raw), '| pieces', pieces.length, '| finish', s.finishReason, `| ${Date.now() - t2}ms`);
  console.log('tokens booked by the limiter this run:', groqLimiter.tokensUsed);
  process.exit(0);
})().catch(e => { console.log('REAL CALL FAILED:', (e as Error).message.slice(0, 500)); process.exit(1); });
