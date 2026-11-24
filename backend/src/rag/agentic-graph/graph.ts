// Assembles the agentic RAG graph: a cyclic StateGraph with two bounded
// loops. This is the "Supervisor" — the conditional edges are the decision
// makers that route between nodes after each step.
//
//   START → router ─(GREETING)→ greet → END
//                  └(else)────→ transform → retrieve → grade
//
//   grade ─(RELEVANT)──────────────────────→ generate
//         ─(INSUFFICIENT, attempts<cap)────→ transform   (retrieve loop)
//         ─(INSUFFICIENT, exhausted)───────→ insufficient → END
//
//   generate → verify
//   verify ─(grounded & useful)───────────→ finalize → END
//          ─(fail, revises<cap)───────────→ revise → verify   (revise loop)
//          ─(fail, exhausted)─────────────→ finalize → END   (best-effort)
import { StateGraph, START, END } from '@langchain/langgraph';
import { AgenticState, type AgenticStateType } from './state';
import { makeNodes } from './nodes';
import { DEFAULT_GRAPH_CONFIG, type GraphConfig, type GraphDeps } from './deps';

export interface BuildOptions {
  deps: GraphDeps;
  config?: Partial<GraphConfig>;
}

// Edge decision after the grader.
function afterGrade(config: GraphConfig) {
  return (s: AgenticStateType): 'generate' | 'transform' | 'insufficient' => {
    if (s.grade === 'RELEVANT') return 'generate';
    // INSUFFICIENT: try one rewrite+retrieve to find better evidence.
    if (s.retrieveAttempts < config.maxRetrieveAttempts) return 'transform';
    // Exhausted. If retrieval DID return chunks, generate from them anyway and
    // let the generator decide (its system prompt refuses on truly-uncovered
    // context) — this matches legacy, which always generates from the
    // floor-passing chunks. A hard "not found" only when retrieval returned
    // nothing at all. Rationale: the grader must never veto an answer the
    // retrieved evidence can actually support (full-run eval 2026-11-22:
    // a strict grader caused 22.9% false refusals on answerable cases where
    // the correct chunk was present and legacy answered them).
    return s.documents.length > 0 ? 'generate' : 'insufficient';
  };
}

// Edge decision after verification.
function afterVerify(config: GraphConfig) {
  return (s: AgenticStateType): 'finalize' | 'revise' => {
    if (s.grounded && s.useful) return 'finalize';
    if (s.reviseAttempts < config.maxReviseAttempts) return 'revise';
    // Out of revise budget: finalize the best draft we have.
    return 'finalize';
  };
}

// Edge decision after the router.
function afterRouter(s: AgenticStateType): 'greet' | 'clarifier' {
  return s.route === 'GREETING' ? 'greet' : 'clarifier';
}

// Edge decision after the clarity assessor.
function afterClarity(s: AgenticStateType): 'transform' | 'clarify' {
  return s.clear ? 'transform' : 'clarify';
}

export function buildAgenticGraph(opts: BuildOptions) {
  const config: GraphConfig = { ...DEFAULT_GRAPH_CONFIG, ...opts.config };
  const n = makeNodes(opts.deps, config);

  const graph = new StateGraph(AgenticState)
    .addNode('router', n.router)
    .addNode('greet', n.greet)
    .addNode('clarifier', n.clarifier)
    .addNode('clarify', n.clarify)
    .addNode('transform', n.transform)
    .addNode('expand', n.expand)
    .addNode('retrieve', n.retrieve)
    .addNode('grader', n.grade)
    .addNode('generate', n.generate)
    .addNode('verify', n.verify)
    .addNode('revise', n.revise)
    .addNode('finalize', n.finalize)
    .addNode('insufficient', n.insufficient)

    .addEdge(START, 'router')
    .addConditionalEdges('router', afterRouter, {
      greet: 'greet',
      clarifier: 'clarifier',
    })
    .addEdge('greet', END)

    .addConditionalEdges('clarifier', afterClarity, {
      transform: 'transform',
      clarify: 'clarify',
    })
    .addEdge('clarify', END)

    .addEdge('transform', 'expand')
    .addEdge('expand', 'retrieve')
    .addEdge('retrieve', 'grader')
    .addConditionalEdges('grader', afterGrade(config), {
      generate: 'generate',
      transform: 'transform',
      insufficient: 'insufficient',
    })
    .addEdge('insufficient', END)

    .addEdge('generate', 'verify')
    .addConditionalEdges('verify', afterVerify(config), {
      finalize: 'finalize',
      revise: 'revise',
    })
    .addEdge('revise', 'verify')
    .addEdge('finalize', END);

  return graph.compile();
}

export type AgenticGraph = ReturnType<typeof buildAgenticGraph>;

// Convenience input shape for invoking the graph.
export interface AgenticInput {
  question: string;
  lectureId: number;
  lectureTitle: string;
  history?: AgenticStateType['history'];
  agentProfileName?: string | null;
}

export async function runAgenticGraph(graph: AgenticGraph, input: AgenticInput): Promise<AgenticStateType> {
  const result = await graph.invoke({
    question: input.question,
    lectureId: input.lectureId,
    lectureTitle: input.lectureTitle,
    history: input.history ?? [],
    agentProfileName: input.agentProfileName ?? null,
  });
  return result as AgenticStateType;
}
