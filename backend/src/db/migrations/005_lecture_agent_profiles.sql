-- Migration 005: lecture agent profiles (one logical AI tutor agent per lecture)
-- Run: psql $DATABASE_URL -f src/db/migrations/005_lecture_agent_profiles.sql
--
-- Stores the identity and lecture-specific instructions of the AI tutor
-- agent that serves a lecture. Agent selection is deterministic: the
-- lecture_id a student is already chatting in IS the key — there is no
-- separate agent id, registry, or routing step. All agents share the one
-- existing RAG pipeline; this table only supplies per-lecture configuration.
--
-- One profile per lecture is enforced by lecture_id being the PRIMARY KEY
-- (unique + not null), so a lecture can never have two profiles and a
-- profile can never exist without a lecture. ON DELETE CASCADE removes the
-- profile together with its lecture, same as lecture_qna_chunks and
-- chat_sessions.
--
-- Additive only: creates one new table, does not alter any existing table
-- or row, and inserts no profiles (profiles are seeded separately).
--
-- Idempotent: safe to rerun. If the table already exists (for example it was
-- created by src/db/migrate.sql during a fresh `npm run db:setup`), this
-- statement is a no-op. The CREATE TABLE below must stay identical to the
-- section "9. lecture_agent_profiles" at the end of src/db/migrate.sql.
--
-- Requires: the `lectures` table (created by src/db/migrate.sql).
--
-- Manual rollback (not executed by this file, removes all agent profiles):
--   DROP TABLE IF EXISTS lecture_agent_profiles;

CREATE TABLE IF NOT EXISTS lecture_agent_profiles (
  lecture_id   INTEGER     PRIMARY KEY REFERENCES lectures(id) ON DELETE CASCADE,
  agent_name   TEXT        NOT NULL,
  instructions TEXT        NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- '\S' = at least one non-whitespace character, so empty strings and
  -- whitespace-only values (spaces, tabs, newlines) are all rejected.
  CONSTRAINT lecture_agent_profiles_agent_name_not_blank
    CHECK (agent_name ~ '\S'),
  CONSTRAINT lecture_agent_profiles_instructions_not_blank
    CHECK (instructions ~ '\S'),
  -- Bounds the prompt size (and therefore per-request LLM cost) that a
  -- single profile can add to every answer-generation call.
  CONSTRAINT lecture_agent_profiles_instructions_max_length
    CHECK (char_length(instructions) <= 4000)
);
