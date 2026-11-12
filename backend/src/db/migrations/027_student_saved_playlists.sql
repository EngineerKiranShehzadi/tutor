-- Personal playlist bookmarks: independent of globally shared admin courses.
-- Saving a playlist NEVER grants access to private RAG data or starts ingestion.
CREATE TABLE IF NOT EXISTS student_saved_playlists (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL CHECK (playlist_id ~ '^[A-Za-z0-9_-]{10,100}$'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  channel_title TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS idx_student_saved_playlists_recent
  ON student_saved_playlists (user_id, created_at DESC);
