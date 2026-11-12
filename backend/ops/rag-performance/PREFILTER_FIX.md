# Reranker-first candidate admission

This patch removes the cosine >= 0.55 gate BEFORE reranking. It is a retrieval
quality change, not an index, dimensionality or latency rollout.

## Behavior

- Vector-only and hybrid paths forward bounded raw top-K vector candidates.
  Hybrid retains parallel full-text retrieval, chunk-ID deduplication and RRF.
- Lecture ID, pinned/active dataset-version membership, SQL distance ordering,
  non-null-vector filter and per-source limit are unchanged.
- The existing reranker floor, answer/piece deduplication, context budgets,
  grounded generator and output guardrails remain in place.
- Every reranker provider must return exactly one finite score for each known
  candidate ID. Missing, duplicated, unknown-ID or non-finite responses fail.
  Raw candidates are NEVER a fallback for reranker failure.
- Decomposed/adaptive retrieval uses the same raw-vector path. A failing aspect
  remains unavailable, not proven absent; its candidate count is preserved.
- New collection/merge trace spans expose counts, candidate IDs, safe reasons,
  and vectorThresholdApplied=false. Selection logs report floor/dedup/budget
  exclusions. New telemetry contains no question text, answers or vectors.

The existing outer chat span still reports similarityThreshold as legacy
configuration metadata. The new collection spans explicitly show it was NOT
applied. Do not change the .env threshold to zero to enable this fix.

## Tests

Run from backend:

```sh
node --test tests/retrieval-prefilter.test.cjs
npm run typecheck
```

The 33 regression tests execute the actual TypeScript service modules using
injected database/provider/trace adapters. They do not load .env or call Neon,
embedding, reranking or generation APIs. Outcomes/typo cases replay recorded
scores; technical-skills scores are deliberately synthetic. That case does NOT
reproduce or prove resolution of the unprovided live technical-skills trace.
The dedicated CI workflow runs these tests and the full backend typecheck.

For a live smoke check, use the correct lecture and an uncached factual query.
Raw candidates should reach reranking even when their cosine scores are below
0.55. Confirm unrelated or unsupported details still yield a grounded refusal.
A reranker outage must produce an availability/error path, not a fabricated
answer or a false claim that the lecture lacks the topic. A new chat alone does
not bypass factual-answer memory; do not wipe the database cache to test this.

## Unchanged

No database migration, re-embedding, HNSW forcing, halfvec, full-index prewarm,
quiz change, answer-cache rewrite or .env edit. Keep optional automatic warm-up
off for this scope: RAG_DB_WARMUP_ENABLED=false and
NEXT_PUBLIC_RAG_DB_WARMUP_ENABLED=false. Existing test indexes are untouched.
