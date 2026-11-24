/**
 * Agentic vs Legacy RAG evaluation — the HONEST comparison.
 *
 *   npm run eval:agentic-vs-legacy            # all approved golden cases, both modes
 *   npm run eval:agentic-vs-legacy -- 10      # cap to first 10 cases
 *   RAG_TEST_EMAIL=you@school.edu npm run eval:agentic-vs-legacy
 *
 * Cheaper targeted runs (env-var filters, combine freely):
 *   EVAL_LECTURES=9,7 npm run eval:agentic-vs-legacy    # only these lecture_ids
 *   EVAL_MODES=agentic npm run eval:agentic-vs-legacy   # only one mode (half the runs)
 *   EVAL_CASES=L9-V22-ab12cd34,... npm run eval:agentic-vs-legacy  # only these case keys
 *   # e.g. re-check just the lectures that regressed, agentic only:
 *   EVAL_LECTURES=9,7 EVAL_MODES=agentic npm run eval:agentic-vs-legacy
 *
 * Why this exists: eval:rag and capture:rag BYPASS chat.service (they call
 * search/rerank/answer directly), so AGENTIC_GRAPH_ENABLED has no effect on
 * them — both runs are legacy. run-lecture6-answer-eval.ts does use the real
 * pipeline but is pinned to an archived version (0 chunks on Neon).
 *
 * This script runs every APPROVED golden case through the REAL askLectureAgent
 * pipeline TWICE — once legacy, once agentic — by toggling env at runtime, then
 * judges each run. Answer memory is disabled (no cross-run contamination) and
 * each case uses a temporary chat session that is deleted afterwards. Nothing
 * is persisted to Neon except the temp sessions, which are cleaned up.
 *
 * Metrics per mode:
 *   - retrievalHit : an expected chunk appeared in the final sources
 *   - correct      : LLM judge — does the answer actually answer the question
 *   - grounded     : LLM judge — is every claim supported by the sources
 *   - refused      : LLM judge — did the answer decline / say "not in lecture"
 *                    (the correct behaviour for out-of-scope cases, a FALSE
 *                     refusal for answerable ones)
 *   - latency      : wall-clock per request
 *
 * Total: 2 * (approved cases) chat runs + the same number of judge calls.
 */
import fs from 'fs';
import path from 'path';
import { query } from '../config/database';
import { env } from '../config/env';
import { askLectureAgent, createChatSession, deleteChatSession } from '../services/chat.service';
import { recordTrace } from '../observability/tracer';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';

const DEFAULT_OUTPUT = '/tmp/agentic-vs-legacy-eval.json';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

type Mode = 'legacy' | 'agentic';

interface GoldenCase {
  caseKey: string;
  lectureId: number;
  datasetVersionId: number;
  question: string;
  expectedAnswer: string | null;
  expectedChunkIds: number[];
  answerable: boolean;
  category: string;
}

interface Judged {
  correct: boolean;
  grounded: boolean;
  refused: boolean;
  reason: string;
}

interface RunResult {
  mode: Mode;
  answer: string;
  sourceChunkIds: number[];
  retrievalHit: boolean | null; // null when the case lists no expected chunks
  latencyMs: number;
  responseStatus: string | null;
  judge: Judged;
  error?: string;
}

// ── Load the approved golden cases pinned to each lecture's ACTIVE version ──
async function loadApprovedGoldenCases(): Promise<GoldenCase[]> {
  const { rows } = await query<any>(
    `SELECT g.case_key, g.lecture_id, g.dataset_version_id, g.question,
            g.expected_answer, g.expected_chunk_ids, g.answerable, g.category
       FROM golden_benchmark_cases g
       JOIN lectures l
         ON l.id = g.lecture_id
        AND l.active_version_id = g.dataset_version_id
      WHERE g.review_status = 'APPROVED'
      ORDER BY g.lecture_id, g.id`
  );
  return rows.map(r => ({
    caseKey: r.case_key,
    lectureId: Number(r.lecture_id),
    datasetVersionId: Number(r.dataset_version_id),
    question: r.question,
    expectedAnswer: r.expected_answer ?? null,
    expectedChunkIds: (r.expected_chunk_ids ?? []).map(Number),
    answerable: r.answerable === true,
    category: r.category,
  }));
}

async function resolveStudentId(email: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]
  );
  if (!rows[0]) throw new Error(`Test account ${email} not found. Set RAG_TEST_EMAIL to an existing student account.`);
  return rows[0].id;
}

// Flip the mode at runtime. `env` is `as const` (readonly to the type system)
// but not frozen, and chat.service reads env.AGENTIC_GRAPH_ENABLED live inside
// askLectureAgent, so mutating it here switches the pipeline for the next call.
function setMode(mode: Mode): void {
  (env as any).AGENTIC_GRAPH_ENABLED = mode === 'agentic';
  // Single-shot eval: a clarifying question would count as a wrong answer, so
  // clarification stays off in BOTH modes (it only exists in agentic anyway).
  (env as any).CLARIFICATION_ENABLED = false;
}

// ── LLM judge — one call per (case, mode) ──────────────────────────────────
const JUDGE_SYSTEM_PROMPT =
  'You are a strict evaluator for a lecture tutoring system. Given a question, an ' +
  'optional reference answer, the retrieved source excerpts, and the tutor\'s answer, ' +
  'return strict JSON: {"correct": boolean, "grounded": boolean, "refused": boolean, ' +
  '"reason": string}.\n' +
  '- refused: true if the tutor declined to answer / said it could not find the ' +
  'information in the lecture (an "I could not find..." style reply).\n' +
  '- correct: true if the tutor answer correctly answers the question, consistent ' +
  'with the reference answer when one is given. For a refused answer, correct=false.\n' +
  '- grounded: true if every factual claim in the tutor answer is supported by the ' +
  'provided source excerpts. A refusal is trivially grounded (grounded=true).';

function buildJudgePrompt(c: GoldenCase, answer: string, sources: string[]): string {
  const ref = c.expectedAnswer ? `Reference answer:\n${c.expectedAnswer}\n\n` : 'Reference answer: (none — out-of-scope case)\n\n';
  const ev = sources.length ? sources.map((s, i) => `[Source ${i + 1}]\n${s}`).join('\n\n') : '(no sources retrieved)';
  return `Question:\n${c.question}\n\n${ref}Retrieved sources:\n${ev}\n\nTutor answer:\n${answer}`;
}

function parseJudge(raw: string): Judged {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const o = JSON.parse(cleaned);
    return {
      correct: o.correct === true,
      grounded: o.grounded === true,
      refused: o.refused === true,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '',
    };
  } catch {
    return { correct: false, grounded: false, refused: false, reason: 'judge-parse-failed' };
  }
}

async function judge(c: GoldenCase, answer: string, sources: string[]): Promise<Judged> {
  const cfg = env.LLM.ANSWER_VERIFICATION;
  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await provider.generate({
      model: cfg.MODEL,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: buildJudgePrompt(c, answer, sources),
      temperature: 0,
      timeoutMs: cfg.TIMEOUT_MS,
    } as Parameters<typeof provider.generate>[0]);
    return parseJudge((result as { raw: string }).raw);
  } catch (err) {
    return { correct: false, grounded: false, refused: false, reason: `judge-error: ${(err as Error).message}` };
  }
}

// ── One (case, mode) run through the REAL pipeline ─────────────────────────
async function runOne(studentId: string, c: GoldenCase, mode: Mode): Promise<RunResult> {
  setMode(mode);
  let sessionId: number | undefined;
  let finishedTrace: any;
  try {
    const session = await createChatSession(studentId, c.lectureId);
    sessionId = session.id;
    const started = Date.now();
    const res = await askLectureAgent(
      { studentId, lectureId: c.lectureId, question: c.question, sessionId },
      {
        datasetVersionId: c.datasetVersionId,
        // Disable answer memory both ways so neither run is a cache hit and
        // nothing persists across runs.
        lookupAnswerMemory: async () => ({ hit: null, embedding: null, datasetVersionId: c.datasetVersionId, lookupFailed: false }),
        writeAnswerMemory: async () => {},
        recordMemoryHit: async () => {},
        onTraceComplete: async trace => { finishedTrace = trace; await recordTrace(trace); },
      }
    );
    const latencyMs = Date.now() - started;
    const sourceChunkIds: number[] = res.sources.map((s: any) => s.id);
    const sourceTexts: string[] = res.sources.map((s: any) => s.chunk_text);
    const retrievalHit = c.expectedChunkIds.length === 0
      ? null
      : c.expectedChunkIds.some(id => sourceChunkIds.includes(id));
    const judged = await judge(c, res.answer, sourceTexts);
    return {
      mode,
      answer: res.answer,
      sourceChunkIds,
      retrievalHit,
      latencyMs,
      responseStatus: finishedTrace?.attributes?.responseStatus ?? null,
      judge: judged,
    };
  } catch (err) {
    return {
      mode, answer: '', sourceChunkIds: [], retrievalHit: null, latencyMs: 0,
      responseStatus: null, judge: { correct: false, grounded: false, refused: false, reason: 'run-error' },
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (sessionId !== undefined) {
      try { await deleteChatSession(studentId, sessionId); }
      catch (e) { console.error(`cleanup session ${sessionId} failed: ${(e as Error).message}`); }
    }
  }
}

// ── Aggregate one mode's runs ──────────────────────────────────────────────
function rate(n: number, d: number): number { return d === 0 ? 0 : n / d; }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

function summarize(cases: GoldenCase[], runs: Map<string, RunResult>, mode: Mode) {
  const ans = cases.filter(c => c.answerable);
  const oos = cases.filter(c => !c.answerable);
  const get = (c: GoldenCase) => runs.get(`${c.caseKey}::${mode}`)!;

  const ansWithExpected = ans.filter(c => c.expectedChunkIds.length > 0);
  const retrievalHit = rate(ansWithExpected.filter(c => get(c).retrievalHit === true).length, ansWithExpected.length);
  const correct = rate(ans.filter(c => get(c).judge.correct).length, ans.length);
  const grounded = rate(ans.filter(c => get(c).judge.grounded).length, ans.length);
  const falseRefusal = rate(ans.filter(c => get(c).judge.refused).length, ans.length);
  const oosRefusal = rate(oos.filter(c => get(c).judge.refused).length, oos.length);

  const allRuns = cases.map(get);
  const latencies = allRuns.map(r => r.latencyMs).filter(x => x > 0).sort((a, b) => a - b);
  const meanLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const errors = allRuns.filter(r => r.error).length;

  return { mode, retrievalHit, correct, grounded, falseRefusal, oosRefusal, meanLatency, p50, errors,
    answerableN: ans.length, oosN: oos.length, retrievalDenom: ansWithExpected.length };
}

const parseList = (v: string | undefined): string[] =>
  (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

async function main() {
  const email = process.env.RAG_TEST_EMAIL ?? 'ragtest@local.test';
  const limit = Number(process.argv[2] ?? 0);
  const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);

  // ── Optional filters (env vars) — run a cheaper subset instead of all 90x2 ──
  //   EVAL_LECTURES=9,7   only these lecture_ids
  //   EVAL_CASES=key1,key2   only these golden case keys
  //   EVAL_MODES=agentic   run only this mode (default: legacy,agentic)
  //   <first arg N>        cap to the first N (after the above filters)
  const lectureFilter = new Set(parseList(process.env.EVAL_LECTURES).map(Number));
  const caseFilter = new Set(parseList(process.env.EVAL_CASES));
  const modesRaw = parseList(process.env.EVAL_MODES).map(s => s.toLowerCase());
  const modes: Mode[] = (modesRaw.length ? modesRaw : ['legacy', 'agentic'])
    .filter((m): m is Mode => m === 'legacy' || m === 'agentic');
  if (modes.length === 0) throw new Error('EVAL_MODES must be legacy and/or agentic.');

  const all = await loadApprovedGoldenCases();
  if (all.length === 0) throw new Error('No APPROVED golden cases pinned to active versions were found.');

  let filtered = all;
  if (lectureFilter.size) filtered = filtered.filter(c => lectureFilter.has(c.lectureId));
  if (caseFilter.size) filtered = filtered.filter(c => caseFilter.has(c.caseKey));
  const cases = limit > 0 ? filtered.slice(0, limit) : filtered;
  if (cases.length === 0) throw new Error('No cases matched the filters (EVAL_LECTURES / EVAL_CASES / limit).');

  const studentId = await resolveStudentId(email);

  const answerable = cases.filter(c => c.answerable).length;
  console.log(`Loaded ${all.length} approved cases; selected ${cases.length} (${answerable} answerable / ${cases.length - answerable} out-of-scope).`);
  if (lectureFilter.size) console.log(`  lecture filter: ${[...lectureFilter].join(', ')}`);
  if (caseFilter.size) console.log(`  case filter: ${caseFilter.size} key(s)`);
  if (limit > 0) console.log(`  limit: first ${cases.length}`);
  console.log(`  modes: ${modes.join(', ')}`);
  console.log(`Total ${cases.length * modes.length} pipeline runs + judge calls. Memory disabled; temp sessions deleted.\n`);

  const runs = new Map<string, RunResult>();
  let i = 0;
  for (const c of cases) {
    for (const mode of modes) {
      const r = await runOne(studentId, c, mode);
      runs.set(`${c.caseKey}::${mode}`, r);
      if (r.error) console.error(`  ! ${c.caseKey} [${mode}] error: ${r.error}`);
      await pause(200);
    }
    i++;
    if (i % 10 === 0 || i === cases.length) console.log(`[${i}/${cases.length}] cases done`);
    // Incremental save (crash-resilient).
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      email, caseCount: cases.length, modes,
      runs: Array.from(runs.entries()).map(([k, v]) => ({ key: k, ...v })),
    }, null, 2), { mode: 0o600 });
  }

  // ── Results table: one column per mode that ran ─────────────────────────
  const summaries = modes.map(m => summarize(cases, runs, m));
  const width = 28 + modes.length * 12;
  const col = (s: string) => s.padStart(12);
  const line = (label: string, vals: string[]) => [label.padEnd(28), ...vals.map(col)].join('');
  console.log(`\n${'='.repeat(width)}`);
  console.log(`RESULTS  (${cases.length} cases: ${summaries[0].answerableN} answerable, ${summaries[0].oosN} out-of-scope)`);
  console.log('='.repeat(width));
  console.log(line('metric', modes.map(m => m.toUpperCase())));
  console.log('-'.repeat(width));
  console.log(line(`retrieval hit (n=${summaries[0].retrievalDenom})`, summaries.map(s => pct(s.retrievalHit))));
  console.log(line('answer correct', summaries.map(s => pct(s.correct))));
  console.log(line('answer grounded', summaries.map(s => pct(s.grounded))));
  console.log(line('false refusal (answerable)', summaries.map(s => pct(s.falseRefusal))));
  console.log(line('OOS refusal (correct)', summaries.map(s => pct(s.oosRefusal))));
  console.log(line('mean latency', summaries.map(s => `${s.meanLatency}ms`)));
  console.log(line('p50 latency', summaries.map(s => `${s.p50}ms`)));
  console.log(line('errors', summaries.map(s => String(s.errors))));
  console.log('='.repeat(width));
  console.log(`\nFull per-case results: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('FATAL:', err); process.exit(1); });
