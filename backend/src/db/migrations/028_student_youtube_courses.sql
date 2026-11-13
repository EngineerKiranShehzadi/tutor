-- Student-owned YouTube courses are deliberately separate from the existing
-- admin-managed shared courses/lectures. No RAG access is granted here.
CREATE TABLE IF NOT EXISTS student_youtube_courses (
  id BIGSERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL CHECK (playlist_id ~ '^[A-Za-z0-9_-]{10,100}$'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  channel_title TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'PREVIEW_ONLY' CHECK (status = 'PREVIEW_ONLY'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_courses_owner ON student_youtube_courses(student_id,created_at DESC);
CREATE TABLE IF NOT EXISTS student_youtube_course_videos (
  course_id BIGINT NOT NULL REFERENCES student_youtube_courses(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  position INT NOT NULL CHECK (position BETWEEN 1 AND 2),
  PRIMARY KEY (course_id, video_id),
  UNIQUE (course_id, position)
);
