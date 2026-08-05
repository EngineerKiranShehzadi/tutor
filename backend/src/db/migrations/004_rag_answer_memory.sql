-- Migration 004: RAG answer memory (lecture-scoped Q&A cache)
-- Run: psql $DATABASE_URL -f src/db/migrations/004_rag_answer_memory.sql
--
-- Reuses a previously generated, lecture-grounded answer for a repeated or
-- safely equivalent standalone FACT_QUESTION from the same student on the
-- same (unchanged) lecture. See rag-answer-memory.service.ts for the
-- read/write logic — this migration only adds a new table; it does not
-- alter any existing table.
--
-- chat_history is intentionally NOT reused as the cache source: it mixes
-- greetings, summaries, contextual follow-ups, not-found answers, and
-- cleared entries, none of which are safe to replay automatically.
--
-- question_embedding dimension (1024) must match embedding.service.ts's
-- EMBEDDING_MODEL_VERSION / the running embedding server's output
-- (BAAI/bge-large-en-v1.5), matching lecture_qna_chunks.local_embedding.
-- If the retrieval embedding model ever changes dimensions, this column
-- and every stored row become incompatible and must be cleared together
-- with local_embedding.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_answer_memory (
  id                      SERIAL PRIMARY KEY,
  student_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id              INT  NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  source_chat_history_id  INT  REFERENCES chat_history(id) ON DELETE SET NULL,

  original_question       TEXT NOT NULL,
  retrieval_query         TEXT NOT NULL,
  normalized_query        TEXT NOT NULL,
  question_embedding      vector(1024) NOT NULL,

  answer                  TEXT NOT NULL,
  source_chunk_ids        INT[] NOT NULL CHECK (array_length(source_chunk_ids, 1) > 0),
  -- Scope is FACT_QUESTION-only for this first implementation (see
  -- rag-answer-memory.service.ts) — stored as a plain column, not
  -- constrained, so a later phase can extend reuse without a migration.
  route                   TEXT NOT NULL DEFAULT 'FACT_QUESTION',

  lecture_content_hash    TEXT NOT NULL,
  embedding_model_version TEXT NOT NULL,
  answer_prompt_version   TEXT NOT NULL,

  cache_eligible          BOOLEAN NOT NULL DEFAULT TRUE,
  hit_count               INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevents duplicate rows for the same student+lecture+question under the
  -- same content/model/prompt version; writes upsert onto this instead.
  UNIQUE (student_id, lecture_id, normalized_query, lecture_content_hash, embedding_model_version, answer_prompt_version)
);

-- Exact lookup filters on all of these columns together; cache_eligible is
-- included since ineligible rows are always excluded from lookups.
CREATE INDEX IF NOT EXISTS idx_rag_memory_exact_lookup
  ON rag_answer_memory (student_id, lecture_id, normalized_query, lecture_content_hash, embedding_model_version, answer_prompt_version)
  WHERE cache_eligible = TRUE;

-- Narrows semantic-candidate scans to one student+lecture+version tuple
-- before the vector distance is ever computed. No ivfflat/hnsw index: rows
-- per (student, lecture) are expected to stay small (a personal question
-- cache, not a corpus), so a plain <=> scan over the pre-filtered rows is
-- simpler and correct at this scale.
CREATE INDEX IF NOT EXISTS idx_rag_memory_semantic_scope
  ON rag_answer_memory (student_id, lecture_id, lecture_content_hash, embedding_model_version, answer_prompt_version)
  WHERE cache_eligible = TRUE;
