-- Private YouTube sessions: do not mix with shared lecture chat sessions.
CREATE TABLE IF NOT EXISTS student_youtube_chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id BIGINT NOT NULL REFERENCES student_youtube_courses(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (course_id,video_id) REFERENCES student_youtube_course_videos(course_id,video_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_sessions_owner
  ON student_youtube_chat_sessions(student_id,course_id,video_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS student_youtube_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES student_youtube_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','ai')),
  content TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_messages_session
  ON student_youtube_chat_messages(session_id,id);
