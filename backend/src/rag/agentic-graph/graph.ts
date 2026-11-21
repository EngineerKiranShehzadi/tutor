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
    // INSUFFICIENT: loop back to rewrite+retrieve while attempts remain.
    if (s.retrieveAttempts < config.maxRetrieveAttempts) return 'transform';
    return 'insufficient';
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
function afterRouter(s: AgenticStateType): 'greet' | 'transform' {
  return s.route === 'GREETING' ? 'greet' : 'transform';
}

export function buildAgenticGraph(opts: BuildOptions) {
  const config: GraphConfig = { ...DEFAULT_GRAPH_CONFIG, ...opts.config };
  const n = makeNodes(opts.deps, config);

  const graph = new StateGraph(AgenticState)
    .addNode('router', n.router)
    .addNode('greet', n.greet)
    .addNode('transform', n.transform)
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
      transform: 'transform',
    })
    .addEdge('greet', END)

    .addEdge('transform', 'retrieve')
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
