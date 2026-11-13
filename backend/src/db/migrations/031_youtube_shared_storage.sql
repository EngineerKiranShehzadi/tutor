-- Non-destructive shared PUBLIC YouTube content cache.
-- Existing READY video/course records and their private chunks remain unchanged.
-- New imports can point at shared content while private chat/session ownership stays isolated.
CREATE TABLE IF NOT EXISTS youtube_shared_content (
  id BIGSERIAL PRIMARY KEY,
  video_id TEXT NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  embedding_model_version TEXT NOT NULL,
  transcript_sha256 TEXT NOT NULL CHECK (transcript_sha256 ~ '^[a-f0-9]{64}$'),
  language TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id,embedding_model_version,transcript_sha256)
);
CREATE INDEX IF NOT EXISTS idx_youtube_shared_video_lookup
  ON youtube_shared_content(video_id,embedding_model_version,created_at DESC);

CREATE TABLE IF NOT EXISTS youtube_shared_chunks (
  content_id BIGINT NOT NULL REFERENCES youtube_shared_content(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL CHECK(chunk_index BETWEEN 0 AND 59),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  local_embedding vector(1024) NOT NULL,
  PRIMARY KEY (content_id,chunk_index)
);

ALTER TABLE student_youtube_course_videos
  ADD COLUMN IF NOT EXISTS shared_content_id BIGINT REFERENCES youtube_shared_content(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_student_youtube_video_shared_content
  ON student_youtube_course_videos(shared_content_id) WHERE shared_content_id IS NOT NULL;

ALTER TABLE student_youtube_courses
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE student_youtube_courses
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Expiration is explicit and non-destructive to chat history.
ALTER TABLE student_youtube_courses DROP CONSTRAINT IF EXISTS student_youtube_courses_status_check;
ALTER TABLE student_youtube_courses
  ADD CONSTRAINT student_youtube_courses_status_check
  CHECK (status IN ('PREVIEW_ONLY','QUEUED','PROCESSING','PARTIAL','READY','FAILED','EXPIRED'));
ALTER TABLE student_youtube_course_videos
  DROP CONSTRAINT IF EXISTS student_youtube_course_videos_ingest_status_check;
ALTER TABLE student_youtube_course_videos
  ADD CONSTRAINT student_youtube_course_videos_ingest_status_check
  CHECK(ingest_status IN ('PREVIEW_ONLY','PROCESSING','READY','FAILED','EXPIRED'));
CREATE INDEX IF NOT EXISTS idx_student_youtube_expiry
  ON student_youtube_courses(expires_at) WHERE expires_at IS NOT NULL;

-- Small operational audit of space and deduplication; read-only view.
CREATE OR REPLACE VIEW youtube_storage_summary AS
SELECT
  (SELECT COUNT(*) FROM student_youtube_course_chunks)::bigint AS legacy_private_chunks,
  (SELECT COUNT(*) FROM youtube_shared_chunks)::bigint AS shared_chunks,
  (SELECT COUNT(*) FROM youtube_shared_content)::bigint AS unique_shared_versions,
  (SELECT COUNT(*) FROM student_youtube_course_videos WHERE shared_content_id IS NOT NULL)::bigint AS reused_mappings,
  pg_database_size(current_database())::bigint AS database_bytes,
  pg_total_relation_size('student_youtube_course_chunks')::bigint AS legacy_chunk_table_bytes,
  pg_total_relation_size('youtube_shared_chunks')::bigint AS shared_chunk_table_bytes;
