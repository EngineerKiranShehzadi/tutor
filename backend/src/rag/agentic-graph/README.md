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

**Done, behind a flag.** `services/chat.service.ts` has an early branch (after
input-guardrail + agent-profile + dataset-version + history) gated on
`env.AGENTIC_GRAPH_ENABLED` (added in `config/env.ts`, default `false`). When
off, the legacy straight-line path runs exactly as before. When on, the graph
owns routing + the reasoning loop; the branch still persists via
`saveChatEntry` + `touchSession` and closes the trace like every other terminal
branch.

### Before flipping the flag ON
- Run `npm run typecheck` — the production files (`production-deps.ts`, `entry.ts`,
  the five agents) and the orchestrator/env edits were authored against the real
  service signatures but need a compile in the full backend (the sandbox they
  were built in can't install the repo's full deps).
- Run a live smoke test on one lecture with `AGENTIC_GRAPH_ENABLED=true`.
- Known gaps in graph mode vs the legacy path (deliberate, for follow-up):
  - the legacy **output-guardrail is not re-run** (the graph self-verifies via
    its groundedness + usefulness nodes);
  - **answer-memory is not written** (the graph doesn't surface the
    `retrievalQuery`/`questionEmbedding` the memory writer needs);
  - **output PII guard and token streaming** are not applied in graph mode
    (pass a stream handler through `production-deps.generate` to restore it).
  - `production-deps.retrieve` embeds + searches the query variants in parallel
    (`Promise.allSettled`, skipping a failed variant) and applies the same
    `dedupeAndSelect` relevance floor as the legacy path, so the two modes are
    compared on equal footing.

### Relevance Grader tuning (important)
The first full eval (2026-11-22, 90 golden cases) found the CRAG grader was the
single biggest regression: it refused 22.9% of answerable cases (vs legacy 1.2%)
even though the correct chunk was retrieved (retrieval hit was 98.8% in BOTH
modes) — mostly where the relevance floor left only 1–2 chunks. Two changes
address this:
- The grader is now **lenient** (sufficient=true if the chunks contain *any*
  relevant info; false only when clearly off-topic).
- When the grader stays INSUFFICIENT after the retry budget **but chunks were
  retrieved, the graph generates from them anyway** (the generator refuses
  truly-uncovered context on its own) instead of returning the canned "not
  found". A hard refusal only when retrieval returned nothing.
- `GRADER_ENABLED=false` disables the grader entirely (every retrieval treated
  as RELEVANT) — useful to A/B whether the grader adds value on a corpus whose
  retrieval is already strong.

Graph refusals/clarifications now report their own `responseStatus`
(NOT_FOUND / CLARIFICATION / GREETING_ANSWERED), so monitoring no longer records
them as ANSWERED.

### Clarification tuning
The clarity assessor only asks when a message has a **dangling reference** it
can't resolve ("explain that", "the other one") — it deliberately does NOT ask
whether a question relates to the lecture (relevance is retrieval's job, so an
off-topic but specific question like "tell me about X" goes straight to the
honest "not found"). Turn it off entirely with `CLARIFICATION_ENABLED=false`
(default `true`). **Set `CLARIFICATION_ENABLED=false` for `npm run eval:rag`** —
in a single-shot eval a clarifying question would otherwise count as a wrong
answer.
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
