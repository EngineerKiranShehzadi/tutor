// Node implementations for the agentic graph.
//
// Each node is a pure async function of (state) -> partial state update. They
// close over the injected deps and config via makeNodes(), so the same node
// code runs in tests (mock deps) and production (real services). Nodes push a
// human-readable line to `trace` for every decision — that log is the FYP's
// audit trail.
import type { AgenticStateType, NodeUpdate } from './state';
import type { GraphConfig, GraphDeps } from './deps';

export interface AgenticNodes {
  router: (s: AgenticStateType) => Promise<NodeUpdate>;
  greet: (s: AgenticStateType) => Promise<NodeUpdate>;
  transform: (s: AgenticStateType) => Promise<NodeUpdate>;
  retrieve: (s: AgenticStateType) => Promise<NodeUpdate>;
  grade: (s: AgenticStateType) => Promise<NodeUpdate>;
  generate: (s: AgenticStateType) => Promise<NodeUpdate>;
  verify: (s: AgenticStateType) => Promise<NodeUpdate>;
  revise: (s: AgenticStateType) => Promise<NodeUpdate>;
  finalize: (s: AgenticStateType) => Promise<NodeUpdate>;
  insufficient: (s: AgenticStateType) => Promise<NodeUpdate>;
}

export function makeNodes(deps: GraphDeps, config: GraphConfig): AgenticNodes {
  return {
    // ── 1. Router ─────────────────────────────────────────────────────────
    async router(s) {
      const route = await deps.classifyRoute(s.question);
      return { route, trace: [`router: route=${route}`] };
    },

    // ── Greeting branch (no retrieval) ────────────────────────────────────
    async greet(s) {
      const answer = await deps.greet(s.question, s.lectureTitle, s.history);
      return { answer, trace: ['greet: returned greeting (no retrieval)'] };
    },

    // ── 2. Query transform ────────────────────────────────────────────────
    async transform(s) {
      const retrievalQuery = await deps.transformQuery(
        s.question,
        s.history,
        s.retrieveAttempts,
      );
      const changed = retrievalQuery !== s.question;
      return {
        retrievalQuery,
        trace: [`transform: attempt=${s.retrieveAttempts} rewritten=${changed}`],
      };
    },

    // ── 3. Retrieve (embed + vector + rerank + dedupe + reorder) ──────────
    async retrieve(s) {
      const query = s.retrievalQuery || s.question;
      const documents = await deps.retrieve(query, s.lectureId);
      return {
        documents,
        // Count THIS pass. The grade edge reads the incremented value to
        // decide whether another retrieve→rewrite loop is still allowed.
        retrieveAttempts: s.retrieveAttempts + 1,
        trace: [`retrieve: query="${query}" -> ${documents.length} chunks (pass ${s.retrieveAttempts + 1})`],
      };
    },

    // ── 4. Relevance grader (CRAG) ────────────────────────────────────────
    async grade(s) {
      // No candidates at all is trivially INSUFFICIENT — skip the LLM call.
      if (s.documents.length === 0) {
        return { grade: 'INSUFFICIENT', trace: ['grade: no documents -> INSUFFICIENT'] };
      }
      const grade = await deps.gradeDocuments(s.question, s.documents);
      return { grade, trace: [`grade: ${grade}`] };
    },

    // ── 5. Generator (lecture persona) ────────────────────────────────────
    async generate(s) {
      const draft = await deps.generate({
        question: s.question,
        documents: s.documents,
        lectureTitle: s.lectureTitle,
        history: s.history,
        agentProfileName: s.agentProfileName,
      });
      return { draft, trace: ['generate: produced draft'] };
    },

    // ── 6. Verify (groundedness + usefulness) ─────────────────────────────
    async verify(s) {
      const { grounded, unsupportedClaims } = await deps.verifyGrounded(
        s.question,
        s.documents,
        s.draft,
      );
      const useful = await deps.verifyUseful(s.question, s.draft);
      return {
        grounded,
        useful,
        unsupportedClaims,
        trace: [`verify: grounded=${grounded} useful=${useful} unsupported=${unsupportedClaims.length}`],
      };
    },

    // ── 6c. Reviser ───────────────────────────────────────────────────────
    async revise(s) {
      const draft = await deps.revise({
        question: s.question,
        documents: s.documents,
        draft: s.draft,
        unsupportedClaims: s.unsupportedClaims,
      });
      return {
        draft,
        reviseAttempts: s.reviseAttempts + 1,
        trace: [`revise: attempt ${s.reviseAttempts + 1}`],
      };
    },

    // ── Terminal: accept the current draft as the answer ──────────────────
    async finalize(s) {
      const exhausted = !(s.grounded && s.useful);
      return {
        answer: s.draft,
        trace: [exhausted ? 'finalize: returning best-effort draft (verify not fully passed)' : 'finalize: verified answer'],
      };
    },

    // ── Terminal: retrieval exhausted, answer honestly ────────────────────
    async insufficient() {
      return {
        answer: config.insufficientAnswer,
        trace: ['insufficient: retrieval exhausted -> honest no-answer'],
      };
    },
  };
}
