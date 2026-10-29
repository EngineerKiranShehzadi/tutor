/**
 * REAL-model check of answer generation + the groundedness verifier (Groq openai/gpt-oss-120b).
 *   source e2e/groq-env.sh && ts-node --transpile-only src/scripts/groq-verifier-check.ts
 * ~8 model calls (a few thousand tokens). Needs GROQ_API_KEY in .env.
 */
import { verifyAnswerGroundedness } from '../rag/guardrails/output/answer-groundedness-verifier.service';
import { generateAnswer } from '../services/llm-gemini.service';
import { groqLimiter } from '../llm/providers/groq-llm.provider';
import { env } from '../config/env';
import type { QnaChunk } from '../types';

if (env.LLM.ANSWER_VERIFICATION.PROVIDER !== 'groq' || env.LLM.RAG_ANSWER.PROVIDER !== 'groq') { console.error('Run with: source e2e/groq-env.sh'); process.exit(2); }

const EVIDENCE = [
  'Topic: zero-shot\nQuestion: What is zero-shot prompting?\nAnswer: Zero-shot prompting means asking the model to do a task with no examples, relying only on the instruction.\nKeywords: zero-shot',
  'Topic: few-shot\nQuestion: What is few-shot prompting?\nAnswer: Few-shot prompting gives the model a handful of worked examples inside the prompt before the real task.\nKeywords: few-shot',
];
const chunk = (id: number, text: string): QnaChunk => ({
  id, lecture_id: 1, topic: null, question: text.match(/Question: (.*)/)![1], answer: text.match(/Answer: (.*)/)![1], chunk_text: text, start_time: null, end_time: null, keywords: null,
});
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };

(async () => {
  const Q = 'What is zero-shot prompting?';
  const verdict = async (draft: string, evidence = EVIDENCE) => {
    const o = await verifyAnswerGroundedness({ question: Q, uncoveredAspects: [], evidenceTexts: evidence, draftAnswer: draft });
    return o.ok ? o.result : { decision: `VERIFIER_FAILED:${o.failureReason}`, unsupportedClaims: [] as string[], missingAspects: [] as string[], reason: '' };
  };

  const good = await verdict('Zero-shot prompting means asking the model to do a task without giving it any examples; it relies only on the instruction.');
  check('V1. Verifier (real model): a draft fully supported by the evidence → VERIFIED', good.decision === 'VERIFIED', `decision=${good.decision} reason="${good.reason}"`);

  const extra = await verdict('Zero-shot prompting means asking the model to do a task with no examples. It was invented at Google in 2015 and always beats few-shot prompting.');
  check('V2. Verifier: a draft adding unsupported claims is NOT verified (REVISE / INSUFFICIENT_EVIDENCE) and names them',
    extra.decision !== 'VERIFIED' && !extra.decision.startsWith('VERIFIER_FAILED'), `decision=${extra.decision} unsupportedClaims=${JSON.stringify(extra.unsupportedClaims).slice(0, 160)}`);

  const contra = await verdict('Zero-shot prompting means giving the model many worked examples before the task.');
  check('V3. Verifier: a draft that contradicts the evidence is NOT verified', contra.decision !== 'VERIFIED' && !contra.decision.startsWith('VERIFIER_FAILED'), `decision=${contra.decision} reason="${contra.reason}"`);

  const none = await verdict('Zero-shot prompting means asking for a task with no examples.', []);
  check('V4. Verifier: an answer with NO retrieved evidence is NOT verified', none.decision !== 'VERIFIED' && !none.decision.startsWith('VERIFIER_FAILED'), `decision=${none.decision}`);

  const chunks = EVIDENCE.map((t, i) => chunk(i + 1, t));
  const ans1 = await generateAnswer(Q, chunks, 'Prompt Engineering Basics', [], [], 1);
  check('G1. Answer generation (real model): in-lecture question is answered from the context', /example/i.test(ans1) && !/could not find/i.test(ans1), `answer="${ans1.replace(/\s+/g, ' ').slice(0, 200)}"`);

  const ans2 = await generateAnswer('What is the capital of France?', chunks, 'Prompt Engineering Basics', [], [], 1);
  check('G2. Answer generation: an out-of-lecture question gets the grounded "could not find" refusal, not an outside-knowledge answer',
    /could not find/i.test(ans2) && !/paris/i.test(ans2), `answer="${ans2.replace(/\s+/g, ' ').slice(0, 160)}"`);

  const streamed: string[] = [];
  const ans3 = await generateAnswer('What is few-shot prompting?', chunks, 'Prompt Engineering Basics', [], [], 1, { onDelta: d => streamed.push(d) });
  check('G3. Streaming answer generation: deltas are delivered and equal the final answer', streamed.length > 1 && streamed.join('') === ans3 && /example/i.test(ans3), `deltas=${streamed.length} answer="${ans3.replace(/\s+/g, ' ').slice(0, 120)}"`);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} real-model checks passed; tokens booked: ${groqLimiter.tokensUsed}`);
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name.slice(0, 3)).join(' '));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('crashed:', (e as Error).message.slice(0, 400)); process.exit(2); });
