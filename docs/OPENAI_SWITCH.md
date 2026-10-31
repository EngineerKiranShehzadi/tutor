# Switching to the production stack (OpenAI + Voyage rerank)

The production stack is:

- **Embedding:** OpenAI `text-embedding-3-small` at 1024 dimensions.
- **Rerank:** Voyage `rerank-3`.
- **LLM:** OpenAI `gpt-6-luna` for all ten tasks.

One `OPENAI_API_KEY` covers embedding and every LLM task. `VOYAGE_API_KEY` covers rerank only.

The code supports this stack. Switching is still an operation, not a config flip. Every stored
vector belongs to the local BGE model, and the retrieval thresholds were tuned for BGE plus
the local reranker.

Do the steps in order. None of them works half-done.

## What changes when the env changes

- `EMBEDDING_MODEL_VERSION` changes from `bge-large-en-v1.5:1024` to
  `openai:text-embedding-3-small:1024`. Every lecture then reads `STALE_EMBEDDING_MODEL`, and
  chat answers `LECTURE_NOT_READY` until that lecture is re-embedded.
- Cached answers are keyed to the old version, so they stop matching. New answers are cached
  as students ask.
- In production, startup refuses to run while `RETRIEVAL_THRESHOLDS_TUNED_FOR` doesn't match
  the providers (`openai:voyage`).
- A rejected or rate-limited OpenAI key stops embedding and every LLM task. A Voyage key
  problem stops reranking. Either way, no question can be answered.
  `/health/ready` probes both without spending tokens.

## 1. Before you start

- The backend is at or after the commit that added the OpenAI LLM adapter (C1).
- Migration 018 is applied (`npm run db:setup`).
- You have an OpenAI key (embedding + LLM) and a Voyage key (rerank).
- Cost of the re-embed: the current 7 lectures are 2,828 pieces, about 1.0M characters
  (roughly 250K tokens). At $0.02 per 1M tokens that is well under one cent.

## 2. Dev database first

In `backend/.env` (local database only):

```bash
OPENAI_API_KEY=sk-...
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
RERANK_PROVIDER=voyage
RERANK_MODEL=rerank-3
VOYAGE_API_KEY=pa-...
# every *_LLM_PROVIDER=openai and *_MODEL=gpt-6-luna, as in .env.example
RAG_ANSWER_FALLBACK_MODEL=gpt-6-luna
```

Then, from `backend/`:

1. `npm run smoke:providers`. It makes one real embedding (it must say 1024 values), one
   rerank, and one tiny call per configured LLM model, with a spend cap of $0.01.
2. `npm run reembed:all`. This is a dry run: every lecture shows `PLANNED` with the pieces it
   would embed.
3. `npm run reembed:all -- --apply`. This rebuilds each lecture through the normal pipeline,
   one at a time, and activates it. The previous version stays as the rollback target.
   If OpenAI is down mid-way, a lecture shows `PAUSED`, or `SKIPPED_IN_FLIGHT` on a later
   run. Its build is kept, and a running backend finishes it within a minute, or
   `npm run seed:retry -- <lectureId>` finishes it now. Run the dry run again until every
   lecture is `UP_TO_DATE`.
4. `npm run tune:thresholds` (needs both keys live). Then set `VECTOR_SIMILARITY_THRESHOLD`,
   `RERANK_MIN_SCORE` and `RETRIEVAL_THRESHOLDS_TUNED_FOR=openai:voyage` together from its
   output. This is also the retrieval evaluation number for the report.
5. Record the cost and latency shape during that run:
   - A plain question makes one query embedding and one rerank call over its candidates
     (up to 15) before the LLM calls.
   - A question split into sub-questions makes that pair once per sub-question
     (`QUERY_DECOMPOSITION_MAX_SUBQUERIES`, default 3).
   - `rag_request_log.est_cost_usd` prices every gpt-6-luna call ($0.10 / $0.50 per 1M
     input / output tokens; cached input is $0.01 but is priced as uncached, so the
     estimate errs high; reasoning tokens bill as output).

## 3. Production (Neon)

Answers stop between switching the env and finishing the re-embed, so plan a short
maintenance window.

1. Back up Neon (`backend/ops/neon-migration/RUNBOOK.md`).
2. Put the settings above and the tuned thresholds from step 2.4 into
   `~/askaitutor-secrets/backend.env.production`. Drop `GEMINI_API_KEY` there: the Gemini
   adapter is gone.
3. Re-embed against Neon from this machine, loading that file for this one command only:
   `set -a; . ~/askaitutor-secrets/backend.env.production; set +a; REEMBED_ALLOW_REMOTE=1 npm run reembed:all -- --apply`.
   The script prints the target host first. Check it.
4. Deploy or restart the backend with the same env. `/health/ready` should show the embedder,
   the reranker and the answer LLM as healthy.
5. Update `START_HERE.md` for teammates. New Neon branches will then have OpenAI vectors, so
   their `EMBEDDING_PROVIDER` must be `openai` too.

## Rolling back

Until a lecture gets another dataset update, its previous version still holds the BGE vectors.
To go back:

1. Roll each lecture back to its previous version (from the dataset page, or `rollbackDataset`).
2. Restore `local-http` for embedding and rerank.
3. Restore the old thresholds, with `RETRIEVAL_THRESHOLDS_TUNED_FOR=local-http:local-http`.

The LLM tasks are not part of a rollback: OpenAI is the only LLM provider, and the answers
do not depend on which vectors are active.

Retention keeps only the active version and one previous one. After a second upload under
OpenAI, the BGE vectors are gone, and going back means re-embedding.
