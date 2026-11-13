-- Student-only RAG content, isolated from globally visible lectures and courses.
-- This pilot uses the existing 1024-dimensional embedding provider.
ALTER TABLE student_youtube_courses
  DROP CONSTRAINT IF EXISTS student_youtube_courses_status_check;
ALTER TABLE student_youtube_courses
  ADD CONSTRAINT student_youtube_courses_status_check
  CHECK (status IN ('PREVIEW_ONLY','QUEUED','PROCESSING','PARTIAL','READY','FAILED'));
ALTER TABLE student_youtube_courses
  ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE student_youtube_courses
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE student_youtube_course_videos
  ADD COLUMN IF NOT EXISTS ingest_status TEXT NOT NULL DEFAULT 'PREVIEW_ONLY';
ALTER TABLE student_youtube_course_videos
  DROP CONSTRAINT IF EXISTS student_youtube_course_videos_ingest_status_check;
ALTER TABLE student_youtube_course_videos
  ADD CONSTRAINT student_youtube_course_videos_ingest_status_check
  CHECK (ingest_status IN ('PREVIEW_ONLY','PROCESSING','READY','FAILED'));
ALTER TABLE student_youtube_course_videos
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE TABLE IF NOT EXISTS student_youtube_course_chunks (
  id SERIAL PRIMARY KEY,
  course_id BIGINT NOT NULL,
  video_id TEXT NOT NULL,
  chunk_index INT NOT NULL CHECK (chunk_index BETWEEN 0 AND 59),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  embedding_model_version TEXT NOT NULL,
  local_embedding vector(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (course_id, video_id)
    REFERENCES student_youtube_course_videos(course_id,video_id) ON DELETE CASCADE,
  UNIQUE(course_id,video_id,chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_chunks_course
  ON student_youtube_course_chunks(course_id,embedding_model_version);

-- Bounded per-student personal Q&A accounting, separate from shared lecture asks.
CREATE TABLE IF NOT EXISTS student_youtube_course_asks (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT NOT NULL REFERENCES student_youtube_courses(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_asks_daily
  ON student_youtube_course_asks(student_id,asked_at DESC);
