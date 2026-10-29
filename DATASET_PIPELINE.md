# Dataset Pipeline: What Was Built and Why

Branch: feature/incremental-dataset-pipeline

This note explains, in simple words, the work done on how a lecture's dataset (the Excel file of questions and answers) is uploaded, processed and made live.

## The problem before

Every time an admin uploaded a dataset for a lecture, the whole lecture was processed again from the start.

- If the upload stopped halfway (server restart, embedding server down), the work was lost and had to be started again.
- Even a one-line change meant every question was embedded again, which wastes time.
- While the new data was being built, the lecture could be in a half-finished state.
- Old cached answers could stay around even after the data had changed, so students could get answers from an outdated dataset.

## The idea

Each upload now creates a new version of the lecture's dataset. The new version is built quietly next to the live one. The lecture keeps answering from the current version the whole time. Only when the new version is fully built and checked does the lecture switch to it. If anything goes wrong, nothing changes for students.

## How an upload works now

1. The file is read and compared with the dataset that is live right now.
2. The system works out which rows are new, which are changed, and which are unchanged.
3. Unchanged rows are not processed again. They reuse the same stored text and the same embedding.
4. Only new or changed rows go to the embedding step.
5. When all embeddings are ready, the version is checked, and then the lecture switches to it in one single step.
6. The previous version is kept, so the admin can go back to it with one click (rollback).

## Merge and Replace

Merge is the default. Rows that are missing from the uploaded file are kept, never deleted by accident.

Replace removes the rows that are missing from the file. It will not do this silently. The admin first sees how many rows would be removed and has to confirm that exact number. If the number does not match, nothing is changed.

There is also a preview option (dry run) which shows what would be added, updated, unchanged or removed, without changing anything.

## How rows are matched

Every question and answer gets a permanent id (qa_id) given by the system. The exported dataset file includes this id, so when the admin edits the file and uploads it again, the system knows exactly which row is which.

- A row with a qa_id is matched by that id. An unknown id is an error, because ids are only given by the system.
- A row without a qa_id is matched only by its exact question text.
- If the same question appears more than once and the system cannot be sure which one a row means, the whole upload is rejected with a clear message. The system never guesses.

## If something fails

- If the embedding server goes down in the middle, the build pauses and keeps its progress. It retries on its own after a short wait and does not need a restart.
- If the whole backend restarts, it finds any unfinished build when it starts and continues from where it stopped. A background check also runs every minute as a safety net.
- A version that keeps failing is marked as failed after a few rounds. The live version is not touched.
- Only one build can run per lecture at a time, so two admins uploading together cannot create duplicates.

## Chat and cached answers

- Each chat request is tied to one dataset version from start to end. If a new version goes live while a student's question is running, that question still finishes on a single consistent version.
- Cached answers now belong to a specific dataset version. After a switch or a rollback, an answer from a different version can never be returned. After a rollback, the older version's cached answers become valid again.
- Chunks that were used as sources in old chat history are kept, so old conversations still show their sources.

## What changed in the admin screen

The lecture page has a new dataset manager. It lets the admin choose merge or replace, see the preview and confirm removals, watch progress and errors, export the current dataset with ids, see the list of versions, and roll back.

## Database changes

Two new migration files, both safe to run more than once. They add things and do not delete anything.

- 006 adds the dataset versions tables, the permanent id on each question, and a stored fingerprint of each chunk's text. It also turns every existing ready lecture into version 1.
- 007 ties cached answers to a dataset version instead of a fingerprint of the whole lecture.

These migrations have NOT been run on the live Neon database. Running them needs a separate approval. The order matters: database first, then the backend, then the frontend, because the new backend code does not work on a database without the migrations. A step by step plan with backup, restore check and rollback is in backend/ops/neon-migration/RUNBOOK.md.

## Temporary Groq provider

Because the Gemini key ran out of quota during testing, a Groq option was added only for testing. It has its own rate limits and a token budget per run so a test cannot use up the daily allowance. Gemini stays the default everywhere. The Groq key lives only in the local .env file and is not part of the commit.

## How it was tested

- 37 database checks on a throwaway local Postgres. They cover first upload, uploading the same file again, merge and replace rules, id matching, ambiguity errors, failed updates, a hard kill and resume, the embedding server going down, two uploads at the same time, rollback, cached answers, and re-embedding after a model change. Passed on Postgres 16 and 17.
- 18 browser checks with a real browser, frontend, backend and embedding model. Gemini was replaced by a stub in this run. Passed.
- A full rehearsal of the Neon migration on a local copy of the same Postgres version. Both migrations took about a third of a second on a copy with about 2,800 chunks.
- Real Groq runs were also done to check the answer flow.

The test steps are written in backend/e2e/README.md. These tests only run against a local throwaway database. They refuse to start if the database is not local.

## Main files

- backend/src/services/dataset-version.service.ts: building, finishing, resuming, publishing and rolling back versions
- backend/src/services/dataset-plan.ts: the row matching rules
- backend/src/db/migrations/006 and 007: the database changes
- backend/src/controllers/dataset.controller.ts and routes: upload, versions, rollback and export
- backend/src/services/chat.service.ts, vector-search.service.ts, rag-answer-memory.service.ts: chat pinned to one version
- frontend/src/components/admin/DatasetManager.tsx: the admin screen
- backend/e2e and backend/ops/neon-migration: tests, rehearsal and the migration plan

## Still pending

- Migrations 006 and 007 are not applied on Neon.
- Real Gemini answers and the groundedness check were not verified end to end because of the quota problem. They were checked with a stub and with Groq.
