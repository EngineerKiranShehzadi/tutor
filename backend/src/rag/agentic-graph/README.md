# Agentic RAG Graph

A cyclic LangGraph (`@langchain/langgraph`) orchestrator for the lecture tutor.
It turns the existing fixed RAG pipeline into an **agentic** one: the graph can
loop back to fix itself (rewrite + re-retrieve when evidence is weak, revise
when an answer isn't grounded/useful) instead of running one straight pass.

## Why this exists

The legacy orchestrator (`services/chat.service.ts`) already does router →
rewrite → retrieve → rerank → generate → verify as a **straight line**. The one
thing it can't do is *go back*. This module adds the two bounded loops that make
the system genuinely agentic, while reusing every existing service.

## The graph

```
START → router ─(GREETING)→ greet → END
               └(else)────→ clarifier ─(ambiguous)→ clarify → END   (ask the student)
                                       └(clear)────→ transform → expand → retrieve → grader
grader ─(RELEVANT)──────────────→ generate
       ─(INSUFFICIENT, tries<cap)→ transform        (retrieve/rewrite loop)
       ─(INSUFFICIENT, exhausted)→ insufficient → END   (honest no-answer)
generate → verify
verify ─(grounded & useful)─────→ finalize → END
       ─(fail, revises<cap)─────→ revise → verify   (revise loop)
       ─(fail, exhausted)───────→ finalize → END    (best-effort draft)
```

- **clarifier** (Clarification agent): if the question is too ambiguous to
  retrieve for, return one clarifying question instead of guessing.
- **expand** (HyDE + Multi-query): turn the query into several retrieval texts
  (the query, a hypothetical answer, paraphrases); `retrieve` embeds each and
  fuses the candidates by chunk id before reranking.

Both loops are bounded by `GraphConfig` (`maxRetrieveAttempts`,
`maxReviseAttempts`) so a non-converging question can never run forever — the
property the FYP evaluation depends on.

## Files

| File | Imports real services? | Role |
|------|:----:|------|
| `state.ts` | no | Shared state (the central memory) + reducers |
| `deps.ts` | no | `GraphDeps` injection surface + `GraphConfig` |
| `nodes.ts` | no | Node implementations (pure; trace every decision) |
| `graph.ts` | no | Assembles the StateGraph + conditional edges |
| `agents/relevance-grader.service.ts` | yes | **NEW** CRAG grader (fail-open) |
| `agents/answer-usefulness.service.ts` | yes | **NEW** Self-RAG usefulness (fail-open) |
| `agents/clarity-assessor.service.ts` | yes | **NEW** Clarification (Phase 2, fail-open) |
| `agents/hyde.service.ts` | yes | **NEW** HyDE hypothetical passage (Phase 2) |
| `agents/multi-query.service.ts` | yes | **NEW** Multi-query paraphrases (Phase 2) |
| `production-deps.ts` | yes | Binds real services into `GraphDeps` (per request) |
| `entry.ts` | yes | `askLectureAgentViaGraph` — the orchestrator's delegation target |

The top four + the test run **without any provider/DB** — that's why the
control-flow tests are fully runnable offline.

## Tests

```
npm run test:agentic-graph
```

10 scenarios / 41 assertions, all with mocked deps: greeting short-circuit,
happy path, the CRAG retrieve loop, retrieve-exhaustion fallback, the revise
loop, revise-exhaustion best-effort, empty-document handling, a reproducibility
check (identical trace across two runs), clarification (ambiguous question asks
instead of retrieving), and HyDE/multi-query expansion (variants fused at the
retriever). No network or DB.

Live quality (does the grader actually grade well on real lectures?) is **not**
covered here by design — wire the real deps and evaluate against the golden
Q&A dataset (`npm run eval:rag`).

## Wiring it into the orchestrator (the rewrite)

The graph owns the reasoning loop; `chat.service.ts` still owns safety and
persistence. Delegate behind a flag:

```ts
// in askLectureAgent(), AFTER input-guardrail + agent-profile + dataset-version
if (env.AGENTIC_GRAPH_ENABLED) {
  const { answer, trace } = await askLectureAgentViaGraph({
    question: guardedQuestion,
    lectureId,
    lectureTitle: lecture.title,
    history: historyTurns,
    context: { agentProfile, datasetVersionId },
  });
  // then: run output-guardrail on `answer`, write answer-memory, save chat entry
}
```

### Before flipping the flag
- Add `AGENTIC_GRAPH_ENABLED` (default `false`) to `config/env.ts`.
- Run `npm run typecheck` — `production-deps.ts`, the two agents and `entry.ts`
  were authored against the service signatures but need a compile in the full
  backend (the sandbox they were built in can't install the repo's full deps).
- Re-attach the cross-cutting concerns in `chat.service.ts` around the call:
  output-guardrail, answer-memory write, OTel spans, and token **streaming**
  (pass a stream handler through `production-deps.generate`).
- Optionally add `dedupeAndSelect` between rerank and reorder in
  `production-deps.retrieve` (left out pending its `DedupeResult` shape).
- Each agent has its own `env.LLM.*` task config — `RELEVANCE_GRADER`,
  `ANSWER_USEFULNESS`, `CLARITY_ASSESSOR`, `HYDE`, `MULTI_QUERY` — all defaulting
  to `DEFAULT_LLM_PROVIDER/MODEL` at `TEMPERATURE=0`. Override per agent via the
  matching env vars (e.g. `RELEVANCE_GRADER_LLM_MODEL`); keep temperature at 0
  for reproducibility.

## Dependency note

LangGraph v1 requires `@langchain/core@^1`; this repo pins `@langchain/core@^0.3`,
so this module targets `@langchain/langgraph@^0.2` (compatible with core 0.3).
Moving to LangGraph v1 later means bumping `@langchain/core` to v1 and
re-checking `@langchain/textsplitters` usage.
