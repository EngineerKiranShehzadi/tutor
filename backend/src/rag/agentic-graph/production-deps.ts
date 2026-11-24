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
import { logger } from '../../utils/logger';
import { classifyRoute } from '../../services/query-router.service';
import { resolveRetrievalQuery } from '../../services/query-rewriter.service';
import { generateEmbedding } from '../../services/embedding.service';
import { searchChunksHybrid } from '../../services/vector-search.service';
import { rerankChunks, reorderForContext, dedupeAndSelect } from '../../services/rerank.service';
import { generateAnswer } from '../../services/answer-generation.service';
import { generateGreetingResponse } from '../../services/greeting-response.service';
import { verifyAnswerGroundedness } from '../guardrails/output/answer-groundedness-verifier.service';
import { reviseAnswer } from '../guardrails/output/answer-revision.service';
import { gradeRelevance } from './agents/relevance-grader.service';
import { judgeUsefulness } from './agents/answer-usefulness.service';
import { assessClarity } from './agents/clarity-assessor.service';
import { generateHyde } from './agents/hyde.service';
import { expandMultiQuery } from './agents/multi-query.service';
import type { GraphDeps } from './deps';
import type { LectureAgentProfile, QnaChunk } from '../../types';

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

  return {
    classifyRoute: async (question) => (await classifyRoute(question)).route,

    greet: (question, lectureTitle, history) =>
      generateGreetingResponse(question, lectureTitle, history),

    // Kill switch: when clarification is disabled, skip the LLM call entirely
    // and always treat the question as clear (straight to retrieval).
    assessClarity: env.CLARIFICATION_ENABLED
      ? (question, history) => assessClarity(question, history, env.LLM.CLARITY_ASSESSOR)
      : async () => ({ clear: true, clarification: '' }),

    transformQuery: async (question, history) =>
      (await resolveRetrievalQuery(question, history)).query,

    expandQuery: async (query) => {
      // Always retrieve for the literal query; add a HyDE hypothetical and a
      // few paraphrases to widen recall. Each sub-agent fails open (returns
      // nothing) so expansion can only help, never break retrieval.
      const variants = [query];
      const [hyde, paraphrases] = await Promise.all([
        generateHyde(query, env.LLM.HYDE),
        expandMultiQuery(query, env.LLM.MULTI_QUERY),
      ]);
      if (hyde) variants.push(hyde);
      variants.push(...paraphrases);
      return variants;
    },

    retrieve: async (queries, lectureId) => {
      const primary = queries[0];
      // Embed + hybrid-search every variant IN PARALLEL. A variant whose
      // embedding or search hangs/fails is skipped (Promise.allSettled) rather
      // than failing the whole request — retrieval proceeds as long as at
      // least one variant returns. This removes both the sequential-embedding
      // latency and the single-variant-timeout cascade.
      const settled = await Promise.allSettled(
        queries.map(async (q) => {
          const embedding = await generateEmbedding(q, true);
          return searchChunksHybrid(embedding, q, lectureId, topK, ctx.datasetVersionId);
        }),
      );
      const byId = new Map<number, QnaChunk>();
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          for (const c of s.value) if (!byId.has(c.id)) byId.set(c.id, c);
        } else {
          logger.warn(`[AGENTIC-RETRIEVE] a query variant failed, skipping it: ${String(s.reason)}`);
        }
      }
      if (byId.size === 0) return [];
      // Rerank the fused candidate set against the primary query, then apply
      // the SAME dedupe + reranker relevance floor the legacy path uses
      // (dedupeAndSelect, default DEFAULT_MIN_RERANK_SCORE) so the two modes
      // are compared on equal footing — agentic doesn't get a richer or
      // lower-quality context than legacy for the same lecture.
      // Rerank the FULL fused pool (not just topN) so dedupeAndSelect can
      // backfill a de-duplicated slot from the next-best candidate — exactly
      // like legacy, which reranks all candidates then selects. Capping at
      // topN before dedupe would leave agentic short a chunk whenever a
      // duplicate is removed.
      const pool = Array.from(byId.values());
      const reranked = await rerankChunks(primary, pool, pool.length);
      const { selected } = dedupeAndSelect(reranked, topN);
      return reorderForContext(selected);
    },

    // Grader kill switch: when disabled, every retrieval is treated as
    // RELEVANT (generation proceeds; the generator still refuses truly
    // uncovered context) — no grader LLM call.
    gradeDocuments: env.GRADER_ENABLED
      ? (question, documents) => gradeRelevance(question, documents, env.LLM.RELEVANCE_GRADER)
      : async () => 'RELEVANT' as const,

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

    verifyUseful: (question, draft) => judgeUsefulness(question, draft, env.LLM.ANSWER_USEFULNESS),

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
