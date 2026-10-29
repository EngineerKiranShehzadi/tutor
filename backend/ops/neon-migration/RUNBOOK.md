# Neon: dataset-versioning migration — backup, restore check, deployment, rollback

**Status: NOT executed on Neon.** Everything below was rehearsed on local PostgreSQL 17.11 containers (same version as the
live database) — see `rehearse.sh` and its log. Running any step on Neon needs the owner's separate go-ahead.

Live facts (read-only query): PostgreSQL 17.11, pgvector 0.8.0, database size 27 MB (`lecture_qna_chunks` 19 MB).

## 0. What the migration does
* `006_dataset_versions.sql` — adds `dataset_versions`, `dataset_version_chunks`, `lectures.active_version_id`, and three columns on
  `lecture_qna_chunks` (`qa_id`, `content_hash`, `embedding_model_version`). Backfills every READY lecture as ACTIVE version 1.
  **Deletes nothing, re-embeds nothing, changes no existing value** (it only fills the new columns).
* `007_answer_memory_dataset_version.sql` — adds `rag_answer_memory.dataset_version_id`, replaces the cache key
  (`lecture_content_hash` → version id), binds still-valid cache rows to version 1. **Deletes no rows.**
* Both are idempotent and run in one transaction each. Measured on the 2.8k-chunk copy: **0.35 s** for both.

## 1. Go / no-go gates (all must hold)
1. Owner approval for the live migration. 2. Gemini quota restored (otherwise live chat cannot be smoke-tested end to end; the
migration itself does not depend on it). 3. `preflight.sql` clean: no lecture in `DATASET_UPLOADED/PROCESSING/EMBEDDING`, zero READY lectures
with un-embedded chunks, `pgvector` present. 4. Backup verified (section 2). 5. No admin uploads during the window.

## 2. Backup (before anything is touched)
Use the **direct** (non-pooler) Neon connection string for dump and migration.
1. **Neon restore point (console, owner action):** create a branch from the current state (e.g. `pre-dataset-versioning`) and note the
   timestamp. *Not verifiable from here:* your plan's point-in-time-restore window — check it in the console.
2. **Logical backup + fingerprint (read-only on Neon):**
   `backend/ops/neon-migration/backup.sh "<NEON_DIRECT_URL>" ~/askai-backups/<date>` — runs pre-flight, fingerprints every table
   (counts + content hashes incl. vectors), `pg_dump -Fc` from a **postgres:17** image (a local pg_dump 16 refuses a v17 server), writes
   `backup.dump` + `.sha256`, and checks the dump is readable. Rehearsal: 14.8 MB for 2,828 chunks.
3. **Restore verification (never against Neon):** start any PG17+pgvector container, then
   `backend/ops/neon-migration/restore-verify.sh <backup dir> postgresql://postgres:<pw>@localhost:<port>/postgres askai_restore_check`
   — verifies the checksum, restores into a scratch DB, re-fingerprints and diffs. Must print `RESTORE VERIFIED`. **No-go if it does not.**

## 3. Deployment order (database → backend → frontend)
| # | Step | Check |
|---|------|-------|
| 1 | `backup.sh` + `restore-verify.sh` (section 2) | `RESTORE VERIFIED` |
| 2 | `psql "<NEON_DIRECT_URL>" -v ON_ERROR_STOP=1 --single-transaction -f src/db/migrations/006_dataset_versions.sql`, then the same for `007_…` | no error |
| 3 | `psql … -f ops/neon-migration/postcheck.sql` | every row `t` |
| 4 | `psql … -At -F'\|' -f ops/neon-migration/snapshot.sql` and diff with the pre-migration `snapshot-source.txt` | identical |
| 5 | Deploy the **backend** (new code). On boot it resumes any interrupted build (none expected) | log: `backend running`, no `[DATASET]` errors |
| 6 | Smoke test: each lecture opens for a student; a previously cached question is answered (memory hit needs no Gemini); admin → lectures → each shows **Live: version 1 · initial** | all 7 lectures |
| 7 | Deploy the **frontend** (new admin dataset screen) | admin screen loads |
| 8 | First real update on one low-traffic lecture: choose file → read the preview → apply | v2 Live; students unaffected meanwhile |

Never deploy the new backend before step 2–4: the new code reads `dataset_version_chunks` and chat would fail on an un-migrated database.
Between step 2 and step 5 the old backend keeps chatting normally; the only effect is that its answer-cache **writes** fail quietly
(logged `memoryWriteFailed`; the answer is still returned). Keep that window short.

## 4. Rollback plan
| Situation | Action | Rehearsed result |
|-----------|--------|------------------|
| Problem found **before step 2** | nothing to undo | — |
| After migration, **no dataset update done yet**, code must go back | redeploy the previous backend; tables stay (harmless). Cache writes keep failing quietly until `down-to-legacy.sql` is run | previous code on migrated DB: `test-agent-readiness` 9/9, `test-rag-answer-memory` 22/24 (the 2 failing checks are the cache **writes**), chat reads unaffected |
| After migration **and ≥1 update** (extra chunk rows exist, the previous code would search them) | run `ops/neon-migration/down-to-legacy.sql` (**needs a fresh approval** — it removes chunks that belong to no live version and cache rows of non-live versions; chunks used by chat history are kept so old answers keep their sources), then redeploy the previous backend | lecture 6: 274 → 273 chunk rows (= live version), version tables gone, previous code: memory 24/24, readiness 9/9, agent-profile 8/8, session-isolation 13/13 |
| Anything unexplained / data doubt | restore: create a **new** Neon branch from the restore point (or `pg_restore` `backup.dump` into a new database) and repoint `DATABASE_URL`. Chats/answers written after the backup are lost — use only if the above cannot fix it | restore of the dump verified by fingerprint |
| A **dataset update** went wrong (not the migration) | admin → Versions → **Roll back** (confirmation dialog) — instant, no deploy | covered by the browser e2e |

## 5. What this rehearsal could NOT prove
* Neon-specific behaviour (branch creation, pooler, PITR window) — owner/console actions; use the direct connection for DDL and dump.
* The stand-in copy has no real `chat_history` rows; chat-source safety is covered by the pipeline tests and the browser run instead.
  `preflight.sql` on the live DB reports its real history counts before anything is changed.
* Real Gemini answers (quota 429 here). Retrieval, versions, caching and rollback were verified with Gemini stubbed.

Repeat the full rehearsal any time (needs the two docker containers):
`BASELINE_BACKEND=<backend dir of the previous commit> backend/ops/neon-migration/rehearse.sh`
