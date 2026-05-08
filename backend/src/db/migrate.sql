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
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
