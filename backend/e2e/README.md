# Dataset pipeline — repeatable tests

Everything runs on a **local** throwaway Postgres; nothing here can touch Neon (every entry point
refuses a `DATABASE_URL` that is not local and named `*test*`/`*pipe*`).

## 0. One-time: local Postgres with pgvector
```bash
docker run -d --name askai-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
```
The real embedding server (`python backend/scripts/embedding_server.py`, :5001) must be running.

## 1. DB-level scenarios (37 checks, fake embedder, real SQL)
```bash
cd backend
PGPASSWORD=test psql -h localhost -p 55432 -U postgres postgres -c "CREATE DATABASE askai_pipe_test"
DATABASE_URL=postgresql://postgres:test@localhost:55432/askai_pipe_test npm run db:setup
DATABASE_URL=postgresql://postgres:test@localhost:55432/askai_pipe_test npm run test:dataset-pipeline
```
Covers first upload, identical re-upload, merge/replace rules, qa_id matching, ambiguity errors, failed updates,
hard-kill + resume, embedding outage (many and single chunk) with no restart, simultaneous uploads, pinned requests,
rollback, answer-memory binding, retention/chat-source safety, model-change re-embedding.
Add `-- --lecture-copy <id>` to also check a backfilled copy of a real lecture.

## 2. Browser end-to-end (18 checks, real Chromium + frontend + backend + embedding model)
```bash
cd backend
npm run e2e:up        # fresh DB askai_e2e_test, embed proxy :5101, backend :5055 (LLM STUBBED), frontend :3055
npm run e2e:browser   # screenshots -> /tmp/askai-e2e/shots, results -> /tmp/askai-e2e/results.json
npm run e2e:down
```
**The LLM is stubbed** in this run (`src/scripts/e2e-server.ts`), so no API key is needed and nothing is spent: real
answer generation and the real groundedness verifier are NOT exercised. Retrieval, versions, cache, SQL, embeddings are real.
Playwright is loaded from `PLAYWRIGHT_PATH` (default: the npx cache); Chromium must be installed for it.
