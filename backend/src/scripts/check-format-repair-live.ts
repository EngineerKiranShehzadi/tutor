/**
 * LIVE check of the format-repair check (response-format-repair-check.service.ts)
 * on the configured answer-verification model. Real calls, real tokens: about
 * 35 short calls, well under one cent on gpt-6-luna.
 *
 * Faithful reflows must come back SAME (served); a repair that adds, drops or
 * flips anything must be refused. The refused set is the R3/R4 cases the old
 * word-count guards let through: a claim in a short table header, one item cut
 * from a 6- or 7-item list, a dropped item named in the question, and a curly
 * "isn’t"/"don’t" turned positive.
 *
 * Usage: npm run check:format-repair-live
 */
import { requireLiveLlm } from './live-llm';
import { checkFormatRepair } from '../rag/guardrails/output/format/response-format-repair-check.service';
import type { ExpectedResponseFormat } from '../rag/guardrails/output/format/response-format.types';

interface Pair { name: string; format: ExpectedResponseFormat; original: string; repaired: string; serve: boolean }

const PROSE = 'Zero-shot prompting gives the model no examples. Few-shot prompting gives the model a few worked examples. '
  + 'Chain-of-thought prompting asks the model to reason step by step before answering.';
const REFLOW = '- Zero-shot prompting gives the model no examples.\n- Few-shot prompting gives the model a few worked examples.\n'
  + '- Chain-of-thought prompting asks the model to reason step by step before answering.';
const TABLE_BODY = '| Zero-shot prompting | Gives the model no examples |\n| Few-shot prompting | Gives the model a few worked examples |\n'
  + '| Chain-of-thought prompting | Asks the model to reason step by step before answering |';
const table = (h: string[], body = TABLE_BODY) => `| ${h.join(' | ')} |\n|---|---|\n${body}`;
const SEQ = 'The five built-in sequence types in Python are lists, tuples, strings, ranges and bytes.';
const TRAIN = 'To train a model you first collect data, then clean it, then split it into training and test sets, then fit the model, and finally evaluate it on the test set.';
const SHOTS = 'Zero-shot prompting gives no examples. One-shot prompting gives one example. Few-shot prompting gives a few examples. Many-shot prompting gives many examples.';
const OSI = 'The seven layers of the OSI model are physical, data link, network, transport, session, presentation and application.';
const SDLC = 'The six phases of the SDLC are planning, analysis, design, implementation, testing and maintenance.';
const ML = 'The three types of machine learning are supervised learning, unsupervised learning and reinforcement learning.';
const CURLY = 'A list isn’t immutable, so you can change it after creating it. A tuple is immutable. You don’t need to import either type.';

const HEADERS = [
  ['Type', 'Description'], ['Metric', 'Definition'], ['Term', 'Meaning'], ['Concept', 'Explanation'], ['Technique', 'How it works'],
  ['Method', 'Purpose'], ['Feature', 'Details'], ['Name', 'What the model gets'], ['Category', 'Example'], ['Approach', 'Key idea'],
];

const PAIRS: Pair[] = [
  // Faithful: must be served.
  { name: 'sentences → bullets', format: 'LIST', original: PROSE, repaired: REFLOW, serve: true },
  { name: 'lead-in sentence dropped', format: 'LIST', original: `There are three types of prompting. ${PROSE}`, repaired: REFLOW, serve: true },
  { name: '5-item sentence → 5 bare bullets', format: 'LIST', original: SEQ, repaired: '- Lists\n- Tuples\n- Strings\n- Ranges\n- Bytes', serve: true },
  { name: 'steps → numbered list', format: 'LIST', original: TRAIN, repaired: '1. Collect data\n2. Clean it\n3. Split it into training and test sets\n4. Fit the model\n5. Evaluate it on the test set', serve: true },
  { name: '7 layers → 7 bullets', format: 'LIST', original: OSI, repaired: '- Physical\n- Data link\n- Network\n- Transport\n- Session\n- Presentation\n- Application', serve: true },
  { name: 'table, "prompting" folded into the header', format: 'TABLE', original: PROSE, repaired: '| Prompting | What it does |\n|---|---|\n| Zero-shot | Gives the model no examples |\n| Few-shot | Gives the model a few worked examples |\n| Chain-of-thought | Asks the model to reason step by step before answering |', serve: true },
  { name: 'table, long plain header', format: 'TABLE', original: PROSE, repaired: table(['Prompting technique', 'What the model is given before it answers']), serve: true },
  { name: 'curly negations kept', format: 'LIST', original: CURLY, repaired: '- A list isn’t immutable, so you can change it after creating it.\n- A tuple is immutable.\n- You don’t need to import either type.', serve: true },
  ...HEADERS.map((h): Pair => ({ name: `table header ${h.join(' / ')}`, format: 'TABLE', original: PROSE, repaired: table(h), serve: true })),

  // Changed: must be refused.
  { name: 'a bullet added', format: 'LIST', original: PROSE, repaired: `${REFLOW}\n- Self-consistency prompting samples several reasoning paths and takes a majority vote.`, serve: false },
  { name: 'a table row added', format: 'TABLE', original: PROSE, repaired: table(['Type', 'Description'], `${TABLE_BODY}\n| Self-consistency prompting | Samples several reasoning paths and takes a majority vote |`), serve: false },
  { name: 'R3: header "Invented by Google"', format: 'TABLE', original: PROSE, repaired: table(['Technique', 'Invented by Google']), serve: false },
  { name: 'R3: header "Accuracy (%)" with 61/78/92', format: 'TABLE', original: PROSE, repaired: '| Technique | Accuracy (%) |\n|---|---|\n| Zero-shot | 61 |\n| Few-shot | 78 |\n| Chain-of-thought | 92 |', serve: false },
  { name: 'header carrying a sentence', format: 'TABLE', original: PROSE, repaired: table(['Type', 'Description, and self-consistency samples several reasoning paths']), serve: false },
  { name: '3 items → 2', format: 'LIST', original: PROSE, repaired: '- Zero-shot prompting gives the model no examples.\n- Few-shot prompting gives the model a few worked examples.', serve: false },
  { name: '5 items → 3', format: 'LIST', original: SEQ, repaired: '- Lists\n- Tuples\n- Strings', serve: false },
  { name: 'half the items, every distinct word kept', format: 'LIST', original: SHOTS, repaired: '- Zero-shot prompting gives no examples.\n- One-shot prompting gives one example.', serve: false },
  { name: 'one of 5 steps dropped', format: 'LIST', original: TRAIN, repaired: '1. Collect data\n2. Clean it\n3. Fit the model\n4. Evaluate it on the test set', serve: false },
  { name: 'R4: one of 7 layers dropped', format: 'LIST', original: OSI, repaired: '- Physical\n- Data link\n- Network\n- Transport\n- Presentation\n- Application', serve: false },
  { name: 'R4: one of 6 phases dropped', format: 'LIST', original: SDLC, repaired: '- Planning\n- Analysis\n- Design\n- Implementation\n- Maintenance', serve: false },
  { name: 'R4: 3rd of 3 named items dropped (words in the question)', format: 'LIST', original: ML, repaired: '- Supervised learning\n- Unsupervised learning', serve: false },
  { name: 'a qualifying clause dropped', format: 'LIST', original: 'Supervised learning needs labelled data; its main algorithms are linear regression, decision trees and neural networks.', repaired: '- Linear regression\n- Decision trees\n- Neural networks', serve: false },
  { name: 'straight "not" dropped', format: 'LIST', original: 'Zero-shot prompting does not give the model examples. Few-shot prompting gives a few worked examples.', repaired: '- Zero-shot prompting does give the model examples.\n- Few-shot prompting gives a few worked examples.', serve: false },
  { name: 'R4: curly "isn’t" → "is"', format: 'LIST', original: CURLY, repaired: '- A list is immutable, so you can change it after creating it.\n- A tuple is immutable.\n- You don’t need to import either type.', serve: false },
  { name: 'R4: curly "don’t" → "do"', format: 'LIST', original: CURLY, repaired: '- A list isn’t immutable, so you can change it after creating it.\n- A tuple is immutable.\n- You do need to import either type.', serve: false },
  { name: 'a negation added', format: 'LIST', original: PROSE, repaired: '- Zero-shot prompting does not give the model examples.\n- Few-shot prompting gives the model a few worked examples.\n- Chain-of-thought prompting asks the model to reason step by step before answering.', serve: false },
];

async function main(): Promise<void> {
  requireLiveLlm();
  let wrong = 0; let failed = 0;
  for (const p of PAIRS) {
    const out = await checkFormatRepair(p.format, p.original, p.repaired);
    if (!out.ok) { failed++; console.log(`ERROR ${p.name} (check call failed)`); continue; }
    const served = out.verdict.rejected === null;
    const ok = served === p.serve;
    if (!ok) wrong++;
    const why = served ? 'served' : `${out.verdict.rejected} ${JSON.stringify([...out.verdict.added, ...out.verdict.dropped, ...out.verdict.changed])}`;
    console.log(`${ok ? 'PASS ' : 'FAIL '} ${p.serve ? 'faithful' : 'changed '}  ${p.name} → ${why}`);
  }
  const faithful = PAIRS.filter(p => p.serve).length;
  console.log(`\n${PAIRS.length - wrong - failed}/${PAIRS.length} judged right (${faithful} faithful, ${PAIRS.length - faithful} changed); ${failed} call(s) failed.`);
  process.exit(wrong + failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
