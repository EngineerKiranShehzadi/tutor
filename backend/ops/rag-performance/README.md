# RAG database warm-up / HNSW experiment

Scope: `feature/multi-format-ingestion`. Existing Node/Express + pg pool,
`lecture_qna_chunks.local_embedding`, lecture/version filtering and 1024-d vectors.
No quiz changes, model changes, threshold changes, answer-cache changes, halfvec
conversion, table split, deployment secrets, paid plan changes, or automatic DDL.

## Implemented

* Optional authenticated `POST /api/v1/chat/retrieval-warmup` with `{lectureId}`.
* Lecture page `/lecture/<id>` triggers it after 250 ms, without blocking UI/chat.
  Existing authenticated axios client is reused, not an exposed database URL.
* Default two real nonzero stored vectors, evenly sampled from the selected
  READY lecture's active version. Model metadata and vector dimensions checked.
* The worker performs up to two scoped cosine top-15 searches and reads returned
  text. This touches sampled search paths/data, NOT every page of every lecture.
  Existing planner chooses exact vs HNSW. No index scan is forced.
* Read-only repeatable-read transaction pins one dataset version. Connection
  checkout deadline (2 s), work deadline (5 s), statement/lock timeouts and cleanup.
  Late pool checkouts are released. Only the worker's own connection is destroyed
  if it overruns. Chat and answer generation are never awaited by this component.
* Six endpoint requests/minute/user; one process-wide task at a time; identical
  concurrent requests coalesce; 120 s success TTL keyed by lecture AND version;
  10 s global start gap; bounded TTL maps. A transaction advisory lock avoids
  overlapping expensive warm-ups across replicas. TTL is process-local, not a
  global persistent cooldown. There is no periodic keepalive or retry loop.
* DISABLED, BUSY and COOLDOWN are explicit. SAMPLED_WARMUP_COMPLETE means sampled
  queries completed, NOT that the whole index is now resident or pinned in RAM.
* Operator-only size, index-install, prewarm and execution-plan SQL files.
  A suitable existing test HNSW index is reused, never automatically duplicated.

## Why not copy the proposed code verbatim?

A zero vector has no cosine direction. A LIMIT-1 graph search cannot guarantee
reading an entire index. `halfvec` reduces precision, so recall must be evaluated
before adopting it. Splitting into new SERIAL-ID tables would need migrations,
source/version mappings, synchronization and citation preservation.

5,656 vector(1024) values need 23,212,224 bytes (~23.21 MB / 22.14 MiB); halfvec
values would need 11,628,736 bytes (~11.63 MB / 11.09 MiB). These are VALUE bytes,
not actual table + TOAST + text + HNSW graph size or total memory requirements.
Neither ~45 MB nor ~22 MB including the index has been measured. A Free-plan
maximum compute allowance is not the selected compute's current RAM. Pooling
reduces connection management overhead but does not remove wake-up/network/I/O.

Postgres shared-buffer hits are separate from Neon's Local File Cache. Prewarming
can be evicted, can evict other pages, adds I/O and can extend billable compute
activity. Old warm/cold timings are not a measured gain from this code change.

## Enable for a controlled test (default OFF)

No `.env` is changed by this commit. Use a local backend connected privately to
`rag-hnsw-test` first, not production. Keep the existing credentials private.

Backend `.env`, then restart backend:

```dotenv
RAG_DB_WARMUP_ENABLED=true
# Optional validated settings; these are the defaults:
RAG_DB_WARMUP_SAMPLES=2
RAG_DB_WARMUP_TIMEOUT_MS=5000
RAG_DB_WARMUP_CONNECT_TIMEOUT_MS=2000
RAG_DB_WARMUP_COOLDOWN_MS=120000
RAG_DB_WARMUP_GLOBAL_GAP_MS=10000
```

Frontend `.env.local`, then restart dev server or rebuild deployed frontend:

```dotenv
NEXT_PUBLIC_RAG_DB_WARMUP_ENABLED=true
```

Disable either switch to stop automatic warming. No background timer keeps Neon
awake. When disabled on the backend, the endpoint returns a static DISABLED
response before auth/database work. When enabled it authenticates with the same
server-side user lookup as existing student APIs. Lecture access in this branch
is shared across authenticated students; future per-course ACLs must also guard
this endpoint. It never returns vectors, text, SQL errors or credentials.

## Two checks for the owner

1. Neon SQL Editor, `rag-hnsw-test`: run `inspect.sql`. Record actual HNSW/table
   sizes, pgvector version, shared_buffers and prewarm availability. Your test
   branch already has an HNSW index; do not create another. `optional-hnsw.sql`
   is only for an explicitly chosen database without a suitable one. It uses
   ordinary CREATE INDEX (brief write blocking), with lock/build deadlines.
2. Enable warm-up above, open a lecture while logged in and inspect Network:
   `/chat/retrieval-warmup` should report status, samples, duration. Ask a fresh
   factual question and export Phoenix trace. Compare warm-up OFF vs ON using
   the SAME fixed questions under matched cache conditions and separate test
   sessions/caches. A new chat does NOT bypass the factual-answer cache. Record
   warm-up cost as well as subsequent retrieval, connection/wake-up and whole
   RAG timings. Do not use answer-cache hits or the best one-off run as proof.

`measure.sql` provides a read-only server execution plan for the known saved
query. It uses no forced HNSW flags. Run under the same settings before/after;
inspect actual index name, hits/reads, 15 returned IDs and execution time. The
SQL-editor duration is not the server Execution Time. Warm-up may help only if
work finishes before the question and useful pages remain cached. It may add
cost or contention without benefit. It cannot shorten embedding/LLM API time.

Optional `optional-prewarm.sql` is an OPERATOR one-off, never a browser route.
Run only after pg_prewarm is installed/authorized. It caps the chosen full HNSW
index at 64 MiB and half of shared_buffers, with a 15 s budget. It loads that
index, NOT all text/TOAST and not all lecture data; it does not pin anything.
A rollback restores local settings, not cache state. No extension auto-install.

## Validation

Run from backend: `node --test tests/rag-warmup.test.cjs` (TypeScript is already a
dev dependency). Tests use injected fake clients, no Neon/model requests. They
exercise flags, IDs/nonzero vectors, coalescing, cooldown/version, failures,
read-only SQL scope, advisory-lock skips, deadlines and cleanup. TypeScript
syntax and core strict typechecking can be run without external API calls.
These are NOT a live Neon performance test. Full application build and live
frontend/backend/database integration must also be checked in the owner runtime.

## Primary references checked

* https://github.com/pgvector/pgvector/blob/v0.8.0/README.md
* https://www.postgresql.org/docs/17/pgprewarm.html
* https://neon.com/docs/introduction/scale-to-zero
* https://neon.com/docs/introduction/monitoring-page
* https://neon.com/docs/connect/connection-pooling
