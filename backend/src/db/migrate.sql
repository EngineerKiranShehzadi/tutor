-- =============================================================
-- AskAITutor — Full Database Migration
-- Run once: psql -h localhost -U postgres -d askaitutor -f src/db/migrate.sql
-- =============================================================

-- ─────────────────────────────────────────────
-- 1. pgvector extension
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────
-- Google OAuth support
--   password_hash is NULL for Google-only users
-- ─────────────────────────────────────────────
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id   TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url  TEXT;

-- ─────────────────────────────────────────────
-- 2. users — add role column if missing
--    Signup always creates STUDENT.
--    Admin is inserted directly via SQL (see bottom).
-- ─────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'STUDENT'
  CHECK (role IN ('STUDENT', 'ADMIN'));

-- ─────────────────────────────────────────────
-- 3. lectures
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lectures (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  youtube_url      TEXT NOT NULL,
  youtube_video_id TEXT,
  status           TEXT NOT NULL DEFAULT 'NO_DATASET'
                   CHECK (status IN ('NO_DATASET','DATASET_UPLOADED','PROCESSING','EMBEDDING','READY','FAILED')),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Embedding progress bar (used by lecture.service.ts / GraphQL progressCurrent/progressTotal)
ALTER TABLE lectures ADD COLUMN IF NOT EXISTS progress_current INT NOT NULL DEFAULT 0;
ALTER TABLE lectures ADD COLUMN IF NOT EXISTS progress_total INT NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────
-- 4. lecture_qna_chunks  (core RAG table)
--    embedding vector(768) = Gemini text-embedding-004
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lecture_qna_chunks (
  id          SERIAL PRIMARY KEY,
  lecture_id  INT REFERENCES lectures(id) ON DELETE CASCADE,
  topic       TEXT,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  chunk_text  TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  keywords    TEXT,
  embedding   vector(3072),  -- gemini-embedding-001 returns 3072 dims
  llm_name    TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS llm_name TEXT;

-- local_embedding: retrieval-model vector, distinct from the unused
-- Gemini `embedding` column above.
--   BAAI/bge-large-en-v1.5 returns 1024 dims (previously all-MiniLM-L6-v2, 384 dims).
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS local_embedding vector(1024);
-- Switching retrieval models: old vectors are a different dimension/space and
-- must be discarded, then every lecture re-embedded via scripts/embed_local.py.
ALTER TABLE lecture_qna_chunks ALTER COLUMN local_embedding TYPE vector(1024) USING NULL;

CREATE INDEX IF NOT EXISTS idx_chunks_lecture_id
  ON lecture_qna_chunks(lecture_id);

-- ─────────────────────────────────────────────
-- 5. chat_history
--    student_id is UUID (matches users.id)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_history (
  id                 SERIAL PRIMARY KEY,
  student_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  lecture_id         INT  REFERENCES lectures(id) ON DELETE CASCADE,
  question           TEXT NOT NULL,
  answer             TEXT NOT NULL,
  source_chunk_ids   INT[],
  cleared_by_student BOOLEAN DEFAULT FALSE,
  display_label      TEXT,
  pinned             BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS display_label TEXT;
ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_history_student_lecture
  ON chat_history(student_id, lecture_id);

-- ─────────────────────────────────────────────
-- 6. student_questions  (admin analytics)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_questions (
  id         SERIAL PRIMARY KEY,
  student_id UUID REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INT  REFERENCES lectures(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- 7. Admin user — uncomment and fill values, then run
--    Steps to create admin:
--    a) Pick a strong password (e.g. "Admin@1234")
--    b) Generate its bcrypt hash using:
--         node -e "const b=require('bcryptjs'); b.hash('Admin@1234',12).then(h=>console.log(h))"
--       (run inside backend/ folder where bcryptjs is installed)
--    c) Paste hash below and uncomment the INSERT
-- ─────────────────────────────────────────────
-- INSERT INTO users (name, email, password_hash, is_verified, role)
-- VALUES (
--   'Admin',
--   'admin@askaitutor.com',
--   'PASTE_BCRYPT_HASH_HERE',
--   TRUE,
--   'ADMIN'
-- )
-- ON CONFLICT (email) DO NOTHING;

-- ─────────────────────────────────────────────
-- 8. chat_sessions  (ChatGPT-style conversation threads)
--    Each session belongs to one (student, lecture) pair.
--    Multiple messages in chat_history link to one session.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         SERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INT  NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_student_lecture
  ON chat_sessions(student_id, lecture_id);

-- Link each chat_history row to a session
ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS session_id INT REFERENCES chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_session
  ON chat_history(session_id);

-- Migrate existing rows: create one "Previous Chats" session per (student, lecture)
-- and attach all orphaned rows to it.
INSERT INTO chat_sessions (student_id, lecture_id, title, created_at, updated_at)
SELECT DISTINCT ON (student_id, lecture_id)
  student_id, lecture_id, 'Previous Chats', MIN(created_at) OVER (PARTITION BY student_id, lecture_id), NOW()
FROM chat_history
WHERE session_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE chat_history ch
SET session_id = cs.id
FROM chat_sessions cs
WHERE ch.student_id = cs.student_id
  AND ch.lecture_id = cs.lecture_id
  AND ch.session_id IS NULL
  AND cs.title = 'Previous Chats';
