# Switching retrieval to Voyage

The decided stack is Voyage for embedding and reranking and Gemini for answers. The code
supports it (`EMBEDDING_PROVIDER=voyage`, `RERANK_PROVIDER=voyage`). Switching is still
an operation, not a config flip: every stored vector belongs to the local BGE model, and the
retrieval thresholds were tuned for BGE.

Do the steps in order. None of them works half-done.

## What changes when the env changes

- `EMBEDDING_MODEL_VERSION` goes from `bge-large-en-v1.5:1024` to `voyage:voyage-4:1024`.
  Every lecture reads `STALE_EMBEDDING_MODEL`, and chat answers `LECTURE_NOT_READY` until
  that lecture is re-embedded.
- Cached answers are keyed to the old version. They stop matching, and new ones are cached
  as students ask.
- In production, startup refuses to run while `RETRIEVAL_THRESHOLDS_TUNED_FOR` doesn't match
  the providers.
- One `VOYAGE_API_KEY` serves both stages. A rejected or rate-limited key stops retrieval
  entirely.

## 1. Before you start

- The backend is at or after the commit that added `npm run reembed:all`. That release also
  has R7: reconcile locks in order and the resume timer doesn't overlap itself.
- Migration 018 is applied (`npm run db:setup`).
- You have a Voyage key with a payment method. Tier 1 is 2,000 requests per minute. A full
  re-embed of the current 7 lectures is 2,828 pieces, about 1.0M characters (roughly 250K
  tokens), well inside the free token allowance.

## 2. Dev database first

In `backend/.env` (local database only):

```bash
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-4
EMBEDDING_DIMENSIONS=1024
RERANK_PROVIDER=voyage
RERANK_MODEL=rerank-3
VOYAGE_API_KEY=pa-...
```

Then, from `backend/`:

1. `npm run smoke:providers`: one real embedding (it must say 1024 values), one rerank, and
   one call to each LLM.
2. `npm run reembed:all`: dry run. Every lecture shows `PLANNED` with the pieces it would
   embed.
3. `npm run reembed:all -- --apply`: rebuilds each lecture through the normal pipeline, one
   at a time, and activates it. The previous version stays as the rollback target. If
   Voyage is down mid-way, a lecture shows `PAUSED`, or `SKIPPED_IN_FLIGHT` on a later run:
   its build is kept, and a running backend finishes it within a minute, or
   `npm run seed:retry -- <lectureId>` finishes it now. Run the dry run again until every
   lecture is `UP_TO_DATE`.
4. `npm run tune:thresholds`, then set `VECTOR_SIMILARITY_THRESHOLD`, `RERANK_MIN_SCORE` and
   `RETRIEVAL_THRESHOLDS_TUNED_FOR=voyage:voyage` together from its output. This is also the
   retrieval evaluation number for the report.
5. Record the cost and latency shape during that run. A plain question makes one query
   embedding and one rerank call over its candidates (up to 15) before the answer LLM. A
   question split into sub-questions makes that pair once per sub-question
   (`QUERY_DECOMPOSITION_MAX_SUBQUERIES`, default 3). These per-question call counts are
   what drive the per-student budget.

## 3. Production (Neon)

Answers stop between switching the env and finishing the re-embed, so plan a short
maintenance window.

1. Back up Neon (`backend/ops/neon-migration/RUNBOOK.md`).
2. Put the Voyage settings and the tuned thresholds from step 2.4 into
   `~/askaitutor-secrets/backend.env.production`.
3. Re-embed against Neon from this machine, loading that file for this one command only:
   `set -a; . ~/askaitutor-secrets/backend.env.production; set +a; REEMBED_ALLOW_REMOTE=1 npm run reembed:all -- --apply`.
   The script prints the target host first. Check it.
4. Deploy or restart the backend with the same env. `/health/ready` probes Voyage for both
   stages.

## Rolling back

Until a lecture gets another dataset update, its previous version still holds the BGE
vectors. To go back, roll each lecture back to its previous version (the dataset page, or
`rollbackDataset`), and restore `local-http`, the old thresholds and
`RETRIEVAL_THRESHOLDS_TUNED_FOR=local-http:local-http`. Retention keeps only the active and
one previous version, so after a second upload under Voyage the BGE vectors are gone and
rolling back means re-embedding.
