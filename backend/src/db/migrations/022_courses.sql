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

-- Compatibility for legacy seed/test scripts that still insert a lecture
-- without course_id. New admin mutations explicitly choose their course.
CREATE OR REPLACE FUNCTION ensure_lecture_course_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.course_id IS NULL THEN
    SELECT id INTO NEW.course_id FROM courses WHERE legacy_key = 'original-playlist' LIMIT 1;
  END IF;
  IF NEW.course_id IS NULL THEN
    RAISE EXCEPTION 'Default course unavailable; apply course migration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_lecture_course_id ON lectures;
CREATE TRIGGER trg_ensure_lecture_course_id
BEFORE INSERT ON lectures
FOR EACH ROW EXECUTE FUNCTION ensure_lecture_course_id();
