// Dependency surface for the agentic graph.
//
// Every side-effecting capability a node needs is a function on this
// interface. Nodes NEVER import a service directly — they call these. That is
// the same dependency-injection seam used across this codebase (deps.query,
// deps.rerankChunks, …) and it buys two things:
//   1. The whole graph is testable with mocks — no OpenAI / Voyage / Postgres
//      needed to exercise routing, the grader loop, retry bounding, etc.
//   2. Production wiring (production-deps.ts) binds the real services in ONE
//      place, so swapping a provider never touches graph logic.
//
// Keep every function here deterministic-friendly: the production bindings
// should call the underlying LLMs at temperature 0 so the same input yields
// the same decision (reproducibility — see docs for why this matters to the
// FYP evaluation).
import type { QnaChunk } from '../../types';
import type { ConversationTurn } from '../../services/answer-generation.service';
import type { LectureQueryRoute } from '../../services/query-router.service';

export interface GenerateArgs {
  question: string;
  documents: QnaChunk[];
  lectureTitle: string;
  history: ConversationTurn[];
  agentProfileName: string | null;
}

export interface ReviseArgs {
  question: string;
  documents: QnaChunk[];
  draft: string;
  unsupportedClaims: string[];
}

export interface GroundednessResult {
  grounded: boolean;
  unsupportedClaims: string[];
}

export interface GraphDeps {
  // 1. Router — which kind of message is this? (wraps query-router.service)
  classifyRoute: (question: string) => Promise<LectureQueryRoute>;

  // Greeting branch — no retrieval (wraps greeting-response.service).
  greet: (question: string, lectureTitle: string, history: ConversationTurn[]) => Promise<string>;

  // 1b. Clarity assessor (Phase 2, Clarification agent). Decides whether the
  //     question is specific enough to retrieve for. When not clear, it also
  //     returns the single clarifying question to put back to the student
  //     (no retrieval happens). Should FAIL-OPEN to clear=true on any error.
  assessClarity: (
    question: string,
    history: ConversationTurn[],
  ) => Promise<{ clear: boolean; clarification: string }>;

  // 2. Query transform — contextualize / rewrite for retrieval. `attempt` is
  //    the current retrieve attempt (0 on the first pass), so a binding may
  //    widen the query on later loops (wraps query-rewriter.service).
  transformQuery: (
    question: string,
    history: ConversationTurn[],
    attempt: number,
  ) => Promise<string>;

  // 2b. Query expansion (Phase 2, HyDE + Multi-query). Given the
  //     contextualized query, returns the set of texts to embed and fuse:
  //     the query itself, a HyDE hypothetical answer, and/or paraphrases.
  //     `attempt` lets later loops widen the set. Must always include at
  //     least the incoming query.
  expandQuery: (
    query: string,
    history: ConversationTurn[],
    attempt: number,
  ) => Promise<string[]>;

  // 3. Retrieve — for EACH variant: embed + vector search; then rerank the
  //    fused candidate set, dedupe and reorder, returning the final ordered
  //    context chunks (wraps embedding + vector-search + rerank).
  retrieve: (queries: string[], lectureId: number) => Promise<QnaChunk[]>;

  // 4. Relevance grader (CRAG) — are these chunks enough to answer? This node
  //    is NEW; it is the decision that drives the retrieve→rewrite→retrieve
  //    loop.
  gradeDocuments: (question: string, documents: QnaChunk[]) => Promise<'RELEVANT' | 'INSUFFICIENT'>;

  // 5. Generator — the lecture-persona answer (wraps answer-generation).
  generate: (args: GenerateArgs) => Promise<string>;

  // 6a. Groundedness verifier — is every claim supported by the chunks?
  //     (wraps answer-groundedness-verifier.service)
  verifyGrounded: (question: string, documents: QnaChunk[], draft: string) => Promise<GroundednessResult>;

  // 6b. Answer-usefulness (Self-RAG) — does the draft actually address the
  //     question? NEW; distinct from groundedness.
  verifyUseful: (question: string, draft: string) => Promise<boolean>;

  // 6c. Reviser — one corrected draft from the verifier's findings (wraps
  //     answer-revision.service).
  revise: (args: ReviseArgs) => Promise<string>;
}

export interface GraphConfig {
  // Max retrieve→rewrite→retrieve cycles before the graph gives up and
  // returns the honest "not found in this lecture" answer.
  maxRetrieveAttempts: number;
  // Max generate→verify→revise cycles before the graph returns the best draft
  // it has (with a trace note) rather than looping further.
  maxReviseAttempts: number;
  // The answer returned when retrieval is exhausted without relevant context.
  // Kept configurable so the wording can match the tutor's voice.
  insufficientAnswer: string;
}

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  maxRetrieveAttempts: 2,
  maxReviseAttempts: 2,
  insufficientAnswer:
    "I couldn't find enough in this lecture's material to answer that reliably. " +
    'Try rephrasing, or ask about a specific part of the lecture.',
};
