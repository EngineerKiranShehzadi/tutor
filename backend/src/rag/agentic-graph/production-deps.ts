// Production bindings: builds a GraphDeps from the REAL services for one
// request. Every node capability maps to an existing service here, in ONE
// place, so graph logic never imports a service directly.
//
// ⚠️ This file imports real value modules (providers, DB-backed services), so
// it only type-checks/runs inside the full backend. Run `npm run typecheck`
// and the live suites in your environment after pulling — the graph's own
// control-flow tests (test-agentic-graph.ts) run without any of this.
//
// It is a PER-REQUEST factory: the orchestrator resolves the lecture agent
// profile and dataset version first, then calls buildProductionDeps(ctx) so
// generate/retrieve close over that request's context. This is how the
// lecture persona and dataset-version pinning stay intact under the rewrite.
import { env } from '../../config/env';
import { classifyRoute } from '../../services/query-router.service';
import { resolveRetrievalQuery } from '../../services/query-rewriter.service';
import { generateEmbedding } from '../../services/embedding.service';
import { searchChunksHybrid } from '../../services/vector-search.service';
import { rerankChunks, reorderForContext } from '../../services/rerank.service';
import { generateAnswer } from '../../services/answer-generation.service';
import { generateGreetingResponse } from '../../services/greeting-response.service';
import { verifyAnswerGroundedness } from '../guardrails/output/answer-groundedness-verifier.service';
import { reviseAnswer } from '../guardrails/output/answer-revision.service';
import { gradeRelevance } from './agents/relevance-grader.service';
import { judgeUsefulness } from './agents/answer-usefulness.service';
import type { GraphDeps } from './deps';
import type { LectureAgentProfile } from '../../types';

export interface ProductionDepsContext {
  // Resolved by the orchestrator before the graph runs (never loaded inside
  // the graph). Null when the lecture has no active profile.
  agentProfile: LectureAgentProfile | null;
  // Pin every retrieval in this request to one dataset version — the same
  // reproducibility guarantee the legacy orchestrator gives. Undefined =>
  // the lecture's active version (resolved in SQL).
  datasetVersionId?: number;
  topK?: number;
  topN?: number;
}

export function buildProductionDeps(ctx: ProductionDepsContext): GraphDeps {
  const topK = ctx.topK ?? 5;
  const topN = ctx.topN ?? 5;
  // Reuse the judge-like verification task config for the two new agents so
  // no new env is required. Split into dedicated tasks later if desired.
  const judgeCfg = env.LLM.ANSWER_VERIFICATION;

  return {
    classifyRoute: async (question) => (await classifyRoute(question)).route,

    greet: (question, lectureTitle, history) =>
      generateGreetingResponse(question, lectureTitle, history),

    transformQuery: async (question, history) =>
      (await resolveRetrievalQuery(question, history)).query,

    retrieve: async (query, lectureId) => {
      const embedding = await generateEmbedding(query, true);
      const candidates = await searchChunksHybrid(embedding, query, lectureId, topK, ctx.datasetVersionId);
      const reranked = await rerankChunks(query, candidates, topN);
      // NOTE: dedupeAndSelect sits between rerank and reorder in the legacy
      // path; add it here once you confirm its DedupeResult shape in your env.
      return reorderForContext(reranked);
    },

    gradeDocuments: (question, documents) => gradeRelevance(question, documents, judgeCfg),

    generate: (args) =>
      generateAnswer(
        args.question,
        args.documents,
        args.lectureTitle,
        args.history,
        [],            // uncoveredAspects — decomposed path only
        1,             // attempt
        undefined,     // stream — add the streaming handler here to restore token streaming
        ctx.agentProfile, // real lecture persona profile, resolved per-request by the orchestrator
      ),

    verifyGrounded: async (question, documents, draft) => {
      const outcome = await verifyAnswerGroundedness({
        question,
        uncoveredAspects: [],
        evidenceTexts: documents.map((d) => d.chunk_text),
        draftAnswer: draft,
      });
      if (!outcome.ok) {
        // Infra failure: fail-open so a verifier outage can't trap the answer
        // in the revise loop. (The legacy guardrail decides this policy too.)
        return { grounded: true, unsupportedClaims: [] };
      }
      return {
        grounded: outcome.result.decision === 'VERIFIED',
        unsupportedClaims: outcome.result.unsupportedClaims,
      };
    },

    verifyUseful: (question, draft) => judgeUsefulness(question, draft, judgeCfg),

    revise: async (args) => {
      const outcome = await reviseAnswer({
        question: args.question,
        evidenceTexts: args.documents.map((d) => d.chunk_text),
        draftAnswer: args.draft,
        unsupportedClaims: args.unsupportedClaims,
        uncoveredAspects: [],
      });
      return outcome.ok ? outcome.revisedAnswer : args.draft;
    },
  };
}
