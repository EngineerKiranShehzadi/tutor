-- Non-destructive multi-course support for AskAITutor.
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  subtitle TEXT NOT NULL DEFAULT '' CHECK (length(subtitle) <= 240),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  legacy_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The seed marker preserves subsequent admin edits to the legacy course name.
INSERT INTO courses (title, subtitle, description, legacy_key)
VALUES (
  'Generative AI Fundamentals',
  'Master the Art of AI Conversations using ChatGPT',
  'Original seven-lecture Generative AI and Prompt Engineering playlist',
  'original-playlist'
)
ON CONFLICT (legacy_key) DO NOTHING;

ALTER TABLE lectures ADD COLUMN IF NOT EXISTS course_id INT REFERENCES courses(id);
UPDATE lectures
SET course_id = (SELECT id FROM courses WHERE legacy_key = 'original-playlist')
WHERE course_id IS NULL;
ALTER TABLE lectures ALTER COLUMN course_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lectures_course_id ON lectures(course_id);
