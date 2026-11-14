# Adaptive Tutoring Modes (English-only pilot)

This is a mode-specific *presentation policy*, not a new RAG pipeline. The base `SYSTEM_PROMPT` rules retain priority; `vector-search.service.ts`, hybrid RRF, Voyage reranker, decomposition/adaptive retrieval, output verification, and citations remain unchanged.

## Flags

- Backend `ADAPTIVE_TUTORING_MODES_ENABLED=true`; **off by default**.
- Frontend `NEXT_PUBLIC_ADAPTIVE_TUTORING_MODES_ENABLED=true`; off by default.
- Socratic (experimental): add `ADAPTIVE_TUTORING_SOCRATIC_ENABLED=true` on the backend and `NEXT_PUBLIC_ADAPTIVE_TUTORING_SOCRATIC_ENABLED=true` on the frontend. Both default off.
- Rollback: disable the flags; pre-existing answer-memory keys resume matching.

Available first-release modes: SIMPLE, ACADEMIC, REAL_LIFE_EXAMPLE, EXAM_PREP. SOCRATIC prompt policy exists but is **gated off by default** until bounded multi-turn progression and educational QA are validated.

## Contract

- Client sends a bounded enum value through SSE and GraphQL fallback; any other value is rejected with 400.
- Backend mode policy is trusted/static; no free-text prompt accepted.
- Mode changes final answer **presentation only** and changes cache identity using `+mode:<MODE>:1` on the existing effective answer-prompt version (which already includes the lecture-agent fingerprint).
- If no mode is requested, old prompting/cache behavior is preserved.
- Selector sits above the lecture chat composer and uses existing CSS theme variables.
- Selected mode is client-side within the active lecture/session. Switching sessions or lectures resets it to Academic. The current first release does not persist mode across a hard reload.
- The existing lecturer-scoped authorization, input guardrails, output-verifier, and SSE final answer reconciliation remain unchanged.
- Do not auto-generate, save, or grade formal quizzes from EXAM_PREP.
- Personal YouTube RAG is **not wired to this new selector**; its existing retrieval pipeline remains separate.

## Safety and QA

Run `npx ts-node --transpile-only src/scripts/test-tutoring-modes.ts` in backend plus full typecheck. Human end-to-end browser checks should include: same question under Simple and Academic produces distinct style but same evidence IDs; same-mode cache reuses eligible verified answers; unsupported questions return the same refusal; prompt-injected materials never override rules; SSE fallback carries the same mode; session change resets choice; Source IDs/citations remain correct.

Socratic mode requires distinct guided-turn state and bounded hint progression before public enablement. Do not enable it based on prompt-only differentiation.
