-- Migration 006: dataset versions (incremental, resumable, safely-published datasets)
-- Run: psql $DATABASE_URL -f src/db/migrations/006_dataset_versions.sql
--
-- Every dataset upload becomes a dataset_versions row. A version is built next
-- to the live one and only becomes the lecture's active version once it is
-- complete and validated, so a failed or half-finished update never affects
-- chat. Versions do not copy chunks: lecture_qna_chunks rows are immutable
-- once written, and dataset_version_chunks says which chunk rows make up each
-- version. An unchanged Q&A is simply a second membership row pointing at the
-- same chunk (and therefore the same embedding) — nothing is re-embedded.
--
-- Additive and idempotent: no existing column is dropped, and no existing
-- chunk, embedding, chat or memory row is deleted or rewritten except for
-- filling in the new qa_id / content_hash / embedding_model_version columns.

CREATE TABLE IF NOT EXISTS dataset_versions (
  id                      SERIAL PRIMARY KEY,
  lecture_id              INT  NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  version_no              INT  NOT NULL,
  status                  TEXT NOT NULL
                          CHECK (status IN ('BUILDING','READY_TO_ACTIVATE','ACTIVE','SUPERSEDED','FAILED','ARCHIVED')),
  mode                    TEXT NOT NULL DEFAULT 'MERGE' CHECK (mode IN ('MERGE','REPLACE')),
  source_filename         TEXT,
  file_hash               TEXT,
  embedding_model_version TEXT NOT NULL,
  chunking_config_version TEXT NOT NULL,
  stats                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts                INT  NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at            TIMESTAMPTZ,
  UNIQUE (lecture_id, version_no)
);

-- At most one version per lecture may be in flight at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dataset_versions_in_flight
  ON dataset_versions (lecture_id)
  WHERE status IN ('BUILDING','READY_TO_ACTIVATE');

-- At most one ACTIVE version per lecture (belt and braces next to
-- lectures.active_version_id).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dataset_versions_active
  ON dataset_versions (lecture_id)
  WHERE status = 'ACTIVE';

ALTER TABLE lectures
  ADD COLUMN IF NOT EXISTS active_version_id INT REFERENCES dataset_versions(id) ON DELETE SET NULL;

-- qa_id: the permanent id of a Q&A within its lecture, assigned by the backend
-- and carried through every version (also exported in the dataset file).
-- content_hash: sha256 of chunk_text (exactly what is embedded).
-- embedding_model_version: which model produced local_embedding (NULL while
-- the chunk has no embedding yet).
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS qa_id TEXT;
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS embedding_model_version TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_lecture_qa ON lecture_qna_chunks (lecture_id, qa_id);

CREATE TABLE IF NOT EXISTS dataset_version_chunks (
  version_id  INT  NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  chunk_id    INT  NOT NULL REFERENCES lecture_qna_chunks(id) ON DELETE CASCADE,
  qa_id       TEXT NOT NULL,
  chunk_index INT  NOT NULL,
  PRIMARY KEY (version_id, chunk_id),
  -- A version contains each piece of each Q&A once: this is what makes a
  -- resumed or repeated build unable to create duplicates.
  UNIQUE (version_id, qa_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_dvc_chunk ON dataset_version_chunks (chunk_id);

-- ── Backfill ────────────────────────────────────────────────────────────
-- Every READY lecture that already has chunks becomes version 1 (ACTIVE).
-- Nothing is re-embedded and no file is needed: qa_id / content_hash are
-- derived from the stored chunk rows. A Q&A is a run of chunks starting at
-- chunk_index = 0 (chunk.service.ts inserts a row's pieces consecutively).
-- Lectures that are not READY (no dataset, or an interrupted old-style
-- embedding) are skipped and go through the new pipeline on their next upload.
DO $$
DECLARE
  r   RECORD;
  vid INT;
BEGIN
  FOR r IN
    SELECT l.id
    FROM lectures l
    WHERE l.active_version_id IS NULL
      AND l.status = 'READY'
      AND EXISTS (SELECT 1 FROM lecture_qna_chunks c WHERE c.lecture_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM lecture_qna_chunks c WHERE c.lecture_id = l.id AND c.local_embedding IS NULL)
  LOOP
    INSERT INTO dataset_versions
      (lecture_id, version_no, status, mode, source_filename, embedding_model_version, chunking_config_version, activated_at, stats)
    VALUES
      (r.id, 1, 'ACTIVE', 'REPLACE', 'backfill of pre-versioning dataset', 'bge-large-en-v1.5:1024',
       'rcts:1800/1200/150/20', NOW(), '{"backfill": true}'::jsonb)
    RETURNING id INTO vid;

    WITH g AS (
      SELECT id,
             SUM(CASE WHEN chunk_index = 0 THEN 1 ELSE 0 END) OVER (ORDER BY id) AS grp
      FROM lecture_qna_chunks
      WHERE lecture_id = r.id
    )
    UPDATE lecture_qna_chunks c
    SET qa_id                   = COALESCE(c.qa_id, 'qa_' || substr(md5(r.id::text || ':' || g.grp::text), 1, 12)),
        content_hash            = COALESCE(c.content_hash, encode(sha256(convert_to(c.chunk_text, 'UTF8')), 'hex')),
        embedding_model_version = COALESCE(c.embedding_model_version,
                                           CASE WHEN c.local_embedding IS NOT NULL THEN 'bge-large-en-v1.5:1024' END)
    FROM g
    WHERE g.id = c.id;

    INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index)
    SELECT vid, c.id, c.qa_id, c.chunk_index
    FROM lecture_qna_chunks c
    WHERE c.lecture_id = r.id;

    UPDATE lectures SET active_version_id = vid WHERE id = r.id;
  END LOOP;
END $$;
