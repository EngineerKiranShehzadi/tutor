/**
 * Detailed control-flow tests for the agentic RAG graph.
 *
 *   npm run test:agentic-graph
 *   (or: ts-node --transpile-only src/scripts/test-agentic-graph.ts)
 *
 * These tests exercise the graph with MOCKED dependencies — no OpenAI, Voyage
 * or Postgres. That is deliberate: the thing worth testing here is the
 * orchestration logic (routing, the CRAG retrieve→rewrite loop, retry
 * bounding, the verify→revise loop, honest fallback), and mocks make every
 * path deterministic and reproducible. Live provider/DB behaviour is covered
 * by the existing :live and provider suites, not here.
 *
 * Each mock records how many times it was called, so a test can assert not
 * just the final answer but the PATH the graph took.
 */
import { buildAgenticGraph, runAgenticGraph } from '../rag/agentic-graph/graph';
import type { GraphDeps } from '../rag/agentic-graph/deps';

// ── tiny assertion harness (matches this repo's script-based test style) ──
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── mock factory ──────────────────────────────────────────────────────────
interface MockCalls {
  classifyRoute: number;
  greet: number;
  assessClarity: number;
  transformQuery: number;
  expandQuery: number;
  retrieve: number;
  gradeDocuments: number;
  generate: number;
  verifyGrounded: number;
  verifyUseful: number;
  revise: number;
}

type Overrides = Partial<GraphDeps>;

function makeMockDeps(overrides: Overrides = {}): { deps: GraphDeps; calls: MockCalls } {
  const calls: MockCalls = {
    classifyRoute: 0, greet: 0, assessClarity: 0, transformQuery: 0, expandQuery: 0,
    retrieve: 0, gradeDocuments: 0, generate: 0, verifyGrounded: 0, verifyUseful: 0, revise: 0,
  };

  // A couple of throwaway "chunks" — shape doesn't matter to the graph logic.
  const sampleChunks = [{ id: 1 }, { id: 2 }] as unknown as Awaited<ReturnType<GraphDeps['retrieve']>>;

  const base: GraphDeps = {
    classifyRoute: async () => { calls.classifyRoute++; return 'FACT_QUESTION'; },
    greet: async () => { calls.greet++; return 'Hello! Ask me about this lecture.'; },
    assessClarity: async () => { calls.assessClarity++; return { clear: true, clarification: '' }; },
    transformQuery: async (q) => { calls.transformQuery++; return q; },
    expandQuery: async (q) => { calls.expandQuery++; return [q]; },
    retrieve: async () => { calls.retrieve++; return sampleChunks; },
    gradeDocuments: async () => { calls.gradeDocuments++; return 'RELEVANT'; },
    generate: async () => { calls.generate++; return 'DRAFT_V1'; },
    verifyGrounded: async () => { calls.verifyGrounded++; return { grounded: true, unsupportedClaims: [] }; },
    verifyUseful: async () => { calls.verifyUseful++; return true; },
    revise: async () => { calls.revise++; return 'DRAFT_REVISED'; },
  };

  // Wrap overrides so their calls are still counted.
  const wrapped: GraphDeps = { ...base };
  (Object.keys(overrides) as (keyof GraphDeps)[]).forEach((k) => {
    const fn = overrides[k] as (...a: unknown[]) => Promise<unknown>;
    (wrapped[k] as unknown) = async (...args: unknown[]) => {
      (calls[k as keyof MockCalls] as number)++;
      return fn(...args);
    };
  });

  return { deps: wrapped, calls };
}

const INPUT = { question: 'What is prompt chaining?', lectureId: 4, lectureTitle: 'Lecture 4' };

async function run(): Promise<void> {
  // ── Scenario 1: greeting → no retrieval ─────────────────────────────────
  console.log('\n[1] Greeting route short-circuits before retrieval');
  {
    const { deps, calls } = makeMockDeps({ classifyRoute: async () => 'GREETING' });
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, { ...INPUT, question: 'hi there' });
    eq('answer is the greeting', s.answer, 'Hello! Ask me about this lecture.');
    eq('greet called once', calls.greet, 1);
    eq('retrieve never called', calls.retrieve, 0);
    eq('generate never called', calls.generate, 0);
    eq('status GREETING_ANSWERED', s.graphStatus, 'GREETING_ANSWERED');
  }

  // ── Scenario 2: happy path (1 retrieve, relevant, verified) ─────────────
  console.log('\n[2] Happy path: relevant on first pass, verified first try');
  {
    const { deps, calls } = makeMockDeps();
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, INPUT);
    eq('answer is the draft', s.answer, 'DRAFT_V1');
    eq('retrieved exactly once', calls.retrieve, 1);
    eq('retrieveAttempts = 1', s.retrieveAttempts, 1);
    eq('no revise', calls.revise, 0);
    eq('reviseAttempts = 0', s.reviseAttempts, 0);
    eq('generated once', calls.generate, 1);
  }

  // ── Scenario 3: CRAG retrieve loop (insufficient then relevant) ─────────
  console.log('\n[3] Grader loop: 1st pass INSUFFICIENT, 2nd RELEVANT');
  {
    let gradeCall = 0;
    const { deps, calls } = makeMockDeps({
      gradeDocuments: async () => (++gradeCall === 1 ? 'INSUFFICIENT' : 'RELEVANT'),
    });
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, INPUT);
    eq('answer produced', s.answer, 'DRAFT_V1');
    eq('transform called twice (rewrite loop)', calls.transformQuery, 2);
    eq('retrieved twice', calls.retrieve, 2);
    eq('retrieveAttempts = 2', s.retrieveAttempts, 2);
    eq('graded twice', calls.gradeDocuments, 2);
  }

  // ── Scenario 4: grader exhausted but docs present → best-effort generate ─
  // The grader must NOT veto an answer the retrieved chunks could support:
  // after the retry budget, if any docs were retrieved, generate anyway.
  console.log('\n[4] Grader exhausted + docs present -> best-effort generate (no hard refusal)');
  {
    const { deps, calls } = makeMockDeps({ gradeDocuments: async () => 'INSUFFICIENT' });
    const g = buildAgenticGraph({ deps, config: { maxRetrieveAttempts: 2 } });
    const s = await runAgenticGraph(g, INPUT);
    eq('retrieveAttempts capped at 2', s.retrieveAttempts, 2);
    eq('generated best-effort', calls.generate, 1);
    eq('answer is the draft (not a hard refusal)', s.answer, 'DRAFT_V1');
    eq('status ANSWERED', s.graphStatus, 'ANSWERED');
  }

  // ── Scenario 5: verify→revise loop (fails once, then passes) ────────────
  console.log('\n[5] Revise loop: not grounded once, then grounded');
  {
    let vCall = 0;
    const { deps, calls } = makeMockDeps({
      verifyGrounded: async () => (++vCall === 1
        ? { grounded: false, unsupportedClaims: ['claim x'] }
        : { grounded: true, unsupportedClaims: [] }),
    });
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, INPUT);
    eq('revised once', calls.revise, 1);
    eq('reviseAttempts = 1', s.reviseAttempts, 1);
    eq('answer is the revised draft', s.answer, 'DRAFT_REVISED');
    eq('verified twice', calls.verifyGrounded, 2);
  }

  // ── Scenario 6: revise exhausted → best-effort finalize ─────────────────
  console.log('\n[6] Revise exhausted: verify never passes, bounded by cap');
  {
    const { deps, calls } = makeMockDeps({
      verifyGrounded: async () => ({ grounded: false, unsupportedClaims: ['x'] }),
      verifyUseful: async () => false,
    });
    const g = buildAgenticGraph({ deps, config: { maxReviseAttempts: 2 } });
    const s = await runAgenticGraph(g, INPUT);
    eq('reviseAttempts capped at 2', s.reviseAttempts, 2);
    eq('revise called twice', calls.revise, 2);
    check('best-effort trace note present', s.trace.some(t => t.includes('best-effort')), s.trace.join(' | '));
    eq('answer is last revised draft', s.answer, 'DRAFT_REVISED');
  }

  // ── Scenario 7: empty retrieval skips the grader LLM call ───────────────
  console.log('\n[7] Empty documents -> INSUFFICIENT without calling grader LLM');
  {
    const { deps, calls } = makeMockDeps({ retrieve: async () => [] });
    const g = buildAgenticGraph({ deps, config: { maxRetrieveAttempts: 1 } });
    const s = await runAgenticGraph(g, INPUT);
    eq('grader LLM never called on empty docs', calls.gradeDocuments, 0);
    eq('retrieveAttempts capped at 1', s.retrieveAttempts, 1);
    check('fell back to honest no-answer', s.answer.startsWith("I couldn't find enough"), s.answer);
    eq('status NOT_FOUND', s.graphStatus, 'NOT_FOUND');
  }

  // ── Scenario 8: reproducibility — same input, identical path twice ──────
  console.log('\n[8] Reproducibility: identical trace across two runs');
  {
    const g1 = buildAgenticGraph({ deps: makeMockDeps().deps });
    const g2 = buildAgenticGraph({ deps: makeMockDeps().deps });
    const a = await runAgenticGraph(g1, INPUT);
    const b = await runAgenticGraph(g2, INPUT);
    eq('same answer', a.answer, b.answer);
    eq('same trace', JSON.stringify(a.trace), JSON.stringify(b.trace));
  }

  // ── Scenario 9: Clarification — ambiguous question asks, no retrieval ────
  console.log('\n[9] Clarification: ambiguous question -> asks, skips retrieval');
  {
    const { deps, calls } = makeMockDeps({
      assessClarity: async () => ({ clear: false, clarification: 'Which prompting technique do you mean?' }),
    });
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, { ...INPUT, question: 'explain that one' });
    eq('answer is the clarifying question', s.answer, 'Which prompting technique do you mean?');
    eq('clarity assessed once', calls.assessClarity, 1);
    eq('transform never called', calls.transformQuery, 0);
    eq('retrieve never called', calls.retrieve, 0);
    eq('generate never called', calls.generate, 0);
    eq('status CLARIFICATION', s.graphStatus, 'CLARIFICATION');
  }

  // ── Scenario 10: HyDE + multi-query expansion fans out retrieval ────────
  console.log('\n[10] Expansion: 3 variants reach the retriever, fused once');
  {
    let seenVariants = 0;
    const { deps, calls } = makeMockDeps({
      expandQuery: async (q: string) => [q, 'hyde hypothetical passage', 'paraphrase one'],
      retrieve: async (queries: string[]) => { seenVariants = queries.length; return [{ id: 1 }] as never; },
    });
    const g = buildAgenticGraph({ deps });
    const s = await runAgenticGraph(g, INPUT);
    eq('expand called once', calls.expandQuery, 1);
    eq('retriever received 3 variants', seenVariants, 3);
    eq('retrieved once (fused)', calls.retrieve, 1);
    eq('answer produced', s.answer, 'DRAFT_V1');
  }

  // ── Scenario 11: off-topic self-contained question skips clarification ──
  // Regression guard for the "Babar Azam" over-triggering bug: a specific but
  // off-topic question must go straight to retrieval and get the honest
  // not-found, NOT a clarification loop.
  console.log('\n[11] Off-topic specific question -> not-found, no clarification loop');
  {
    const { deps, calls } = makeMockDeps({
      // Conservative assessor: a self-contained question is clear even if
      // off-topic.
      assessClarity: async () => ({ clear: true, clarification: '' }),
      // Off-topic => retrieval finds nothing.
      retrieve: async () => [],
    });
    const g = buildAgenticGraph({ deps, config: { maxRetrieveAttempts: 2 } });
    const s = await runAgenticGraph(g, { ...INPUT, question: 'tell me about Babar Azam' });
    eq('clarity assessed once', calls.assessClarity, 1);
    check('fell back to honest no-answer', s.answer.startsWith("I couldn't find enough"), s.answer);
    eq('generate never called', calls.generate, 0);
    eq('status NOT_FOUND', s.graphStatus, 'NOT_FOUND');
  }

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(52)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All agentic-graph control-flow tests passed.');
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
