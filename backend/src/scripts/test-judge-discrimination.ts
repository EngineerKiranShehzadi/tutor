/**
 * Sanity check: every real eval run so far scored 100% Faithfulness and
 * 100% Relevancy on every condition. Before trusting that as "the pipeline
 * is perfect," confirm the judge (gemini-flash-lite-latest, the same model
 * used in the real comparisons) can actually tell a bad answer from a good
 * one. Feeds it deliberately wrong answers alongside real good ones and
 * checks whether PASS/FAIL tracks reality.
 *
 * Usage: npm run test:judge-discrimination
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}
const judgeClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const judgeModel = judgeClient.getGenerativeModel({
  model: 'gemini-flash-lite-latest',
  generationConfig: { temperature: 0 },
});

async function askJudge(prompt: string): Promise<{ verdict: string; raw: string }> {
  const result = await judgeModel.generateContent(prompt);
  const raw = result.response.text().trim();
  return { verdict: raw.toUpperCase().startsWith('PASS') ? 'PASS' : 'FAIL', raw };
}

function judgeFaithfulness(answer: string, context: string) {
  return askJudge(`You are evaluating an AI tutor's answer for faithfulness to its source material.

Context (retrieved lecture content):
${context}

Answer:
${answer}

Does the answer ONLY contain information that is supported by the context above, with no fabricated or invented facts?
Respond with exactly one word: PASS or FAIL.`);
}

function judgeRelevancy(question: string, answer: string) {
  return askJudge(`You are evaluating whether an AI tutor's answer actually addresses the student's question.

Question: ${question}
Answer: ${answer}

Does the answer directly and adequately address the question?
Respond with exactly one word: PASS or FAIL.`);
}

const REAL_CONTEXT = `Topic: ChatGPT 5.2
Q: What are typical risks if we rely only on AI to fulfill information needs?
A: Relying only on AI carries risks such as hallucinated or inaccurate information, lack of source transparency, outdated knowledge cutoffs, and reduced critical thinking if users blindly trust AI outputs without verification.`;

const cases: { label: string; expected: 'PASS' | 'FAIL'; run: () => Promise<{ verdict: string; raw: string }> }[] = [
  {
    label: 'Faithfulness — GOOD answer, grounded in context (expect PASS)',
    expected: 'PASS',
    run: () => judgeFaithfulness(
      'Relying only on AI carries risks such as hallucinated information, lack of source transparency, and outdated knowledge.',
      REAL_CONTEXT
    ),
  },
  {
    label: 'Faithfulness — FABRICATED fact not in context (expect FAIL)',
    expected: 'FAIL',
    run: () => judgeFaithfulness(
      'Relying only on AI carries risks such as hallucinated information. Additionally, studies show AI systems consume 40% more electricity than traditional search engines and were banned in three countries in 2023.',
      REAL_CONTEXT
    ),
  },
  {
    label: 'Faithfulness — answer CONTRADICTS context (expect FAIL)',
    expected: 'FAIL',
    run: () => judgeFaithfulness(
      'Relying only on AI is completely safe and has no notable risks compared to traditional information sources.',
      REAL_CONTEXT
    ),
  },
  {
    label: 'Relevancy — GOOD answer, on-topic (expect PASS)',
    expected: 'PASS',
    run: () => judgeRelevancy(
      'What are typical risks if we rely only on AI to fulfill information needs?',
      'Risks include hallucinated information, lack of source transparency, and outdated knowledge cutoffs.'
    ),
  },
  {
    label: 'Relevancy — answer to a COMPLETELY DIFFERENT question (expect FAIL)',
    expected: 'FAIL',
    run: () => judgeRelevancy(
      'What are typical risks if we rely only on AI to fulfill information needs?',
      'The capital of France is Paris, and it is known for the Eiffel Tower, which was completed in 1889.'
    ),
  },
  {
    label: 'Relevancy — answer about a RELATED but different lecture topic (expect FAIL)',
    expected: 'FAIL',
    run: () => judgeRelevancy(
      'What are typical risks if we rely only on AI to fulfill information needs?',
      'Non-AI systems are rule-based and deterministic, following fixed logic defined by developers rather than learned patterns.'
    ),
  },
];

async function main() {
  let correct = 0;
  for (const c of cases) {
    const result = await c.run();
    const isCorrect = result.verdict === c.expected;
    if (isCorrect) correct++;
    console.log(`\n${c.label}`);
    console.log(`  Expected: ${c.expected} | Got: ${result.verdict} | ${isCorrect ? '✅ CORRECT' : '❌ WRONG'}`);
    console.log(`  Raw response: "${result.raw}"`);
  }
  console.log(`\n=== Judge discrimination: ${correct}/${cases.length} correct ===`);
  if (correct < cases.length) {
    console.log('⚠️  The judge is NOT reliably discriminating — eval methodology needs fixing before trusting before/after comparisons.');
  } else {
    console.log('✅ Judge correctly distinguished good from bad on all test cases — the 100%/100% results in real runs likely reflect a genuinely strong pipeline, not a broken judge.');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
