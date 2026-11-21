// Shared state for the agentic RAG graph.
//
// This is the single object that flows through every node from START to END
// (the "Central Memory"). A node never mutates it in place — each node
// returns a PARTIAL update and LangGraph merges it in using the per-field
// reducers declared below. That immutability is what keeps the graph
// reproducible and traceable (see test-agentic-graph.ts), which matters more
// for the FYP evaluation than raw features.
//
// Only @langchain/langgraph and type-only repo imports are used here, so the
// module stays runnable in isolation (no DB / provider wiring needed to test
// the control flow).
import { Annotation } from '@langchain/langgraph';
import type { QnaChunk } from '../../types';
import type { ConversationTurn } from '../../services/answer-generation.service';
import type { LectureQueryRoute } from '../../services/query-router.service';

// The grade a retrieval pass earns from the Relevance Grader node. '' is the
// pre-grade zero value (no grading has happened yet).
export type RetrievalGrade = 'RELEVANT' | 'INSUFFICIENT' | '';

// A single last-write-wins reducer, reused for every scalar field so a later
// node's value cleanly replaces an earlier one.
const replace = <T>(_current: T, incoming: T): T => incoming;

export const AgenticState = Annotation.Root({
  // ── Inputs (set once at invoke time) ───────────────────────────────────
  question: Annotation<string>({ reducer: replace, default: () => '' }),
  lectureId: Annotation<number>({ reducer: replace, default: () => 0 }),
  lectureTitle: Annotation<string>({ reducer: replace, default: () => '' }),
  history: Annotation<ConversationTurn[]>({ reducer: replace, default: () => [] }),
  // The lecture persona name (Nova, Sage, …). Pass-through only; the real
  // profile/instructions are resolved outside the graph and handed to the
  // generate dependency. Null when a lecture has no active profile.
  agentProfileName: Annotation<string | null>({ reducer: replace, default: () => null }),

  // ── Working fields (written by nodes) ──────────────────────────────────
  route: Annotation<LectureQueryRoute | ''>({ reducer: replace, default: () => '' }),
  retrievalQuery: Annotation<string>({ reducer: replace, default: () => '' }),
  documents: Annotation<QnaChunk[]>({ reducer: replace, default: () => [] }),
  grade: Annotation<RetrievalGrade>({ reducer: replace, default: () => '' }),
  draft: Annotation<string>({ reducer: replace, default: () => '' }),
  grounded: Annotation<boolean>({ reducer: replace, default: () => false }),
  useful: Annotation<boolean>({ reducer: replace, default: () => false }),
  unsupportedClaims: Annotation<string[]>({ reducer: replace, default: () => [] }),

  // ── Loop counters (bound the two cycles) ───────────────────────────────
  // Incremented by the retrieve node and the revise node respectively. The
  // conditional edges compare these against the graph config's caps so a
  // non-converging loop can never run forever — the property the FYP's
  // reproducibility story depends on.
  retrieveAttempts: Annotation<number>({ reducer: replace, default: () => 0 }),
  reviseAttempts: Annotation<number>({ reducer: replace, default: () => 0 }),

  // ── Output ─────────────────────────────────────────────────────────────
  answer: Annotation<string>({ reducer: replace, default: () => '' }),

  // ── Observability ──────────────────────────────────────────────────────
  // Ordered log of every decision the graph made. Append reducer, so each
  // node adds a line and nothing is lost. This is what makes a run auditable
  // (which path was taken, how many loops) without a live tracer attached.
  trace: Annotation<string[]>({
    reducer: (current: string[], incoming: string[]) => current.concat(incoming),
    default: () => [],
  }),
});

// The concrete state object type, derived from the annotation.
export type AgenticStateType = typeof AgenticState.State;

// What a node returns: any subset of the state fields.
export type NodeUpdate = Partial<AgenticStateType>;
