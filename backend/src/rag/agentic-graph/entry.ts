// Production entry point for the agentic graph — the delegation target the
// orchestrator (chat.service.ts) calls when AGENTIC_GRAPH_ENABLED is on.
//
// ⚠️ Imports real services via production-deps — type-checks/runs only in the
// full backend. Keep the graph's own tests (test-agentic-graph.ts) independent
// of this file.
//
// Cross-cutting concerns NOT handled inside the graph (and why): input/output
// guardrails, dataset-version resolution, agent-profile loading, answer-memory
// caching and OTel tracing stay in chat.service.ts AROUND this call. The
// orchestrator resolves the profile + dataset version, runs its guardrails,
// then delegates the retrieve→grade→generate→verify core to the graph, then
// writes answer-memory. That keeps the rewrite safe: the graph owns the
// reasoning loop, the orchestrator still owns safety and persistence.
import { buildAgenticGraph } from './graph';
import { runAgenticGraph } from './graph';
import { buildProductionDeps, type ProductionDepsContext } from './production-deps';
import type { ConversationTurn } from '../../services/answer-generation.service';
import type { AgenticStateType } from './state';

export interface AskViaGraphInput {
  question: string;
  lectureId: number;
  lectureTitle: string;
  history?: ConversationTurn[];
  context: ProductionDepsContext; // agentProfile + datasetVersionId resolved by the orchestrator
}

export interface AskViaGraphResult {
  answer: string;
  // Full decision log for observability / evaluation (which path, how many loops).
  trace: string[];
  // Final state, in case the caller wants documents, grade, counters, etc.
  state: AgenticStateType;
}

export async function askLectureAgentViaGraph(input: AskViaGraphInput): Promise<AskViaGraphResult> {
  const deps = buildProductionDeps(input.context);
  const graph = buildAgenticGraph({ deps });
  const state = await runAgenticGraph(graph, {
    question: input.question,
    lectureId: input.lectureId,
    lectureTitle: input.lectureTitle,
    history: input.history ?? [],
    agentProfileName: input.context.agentProfile?.agent_name ?? null,
  });
  return { answer: state.answer, trace: state.trace, state };
}
