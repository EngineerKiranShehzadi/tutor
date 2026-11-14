-- 035: Session-bound, bounded Socratic guidance state. Additive and optional.
-- One active study topic per owned chat session. No learner grading or automatic mastery changes.
CREATE TABLE IF NOT EXISTS socratic_chat_state (
  session_id INT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  anchor_question TEXT NOT NULL CHECK (length(btrim(anchor_question)) BETWEEN 3 AND 2000),
  next_stage SMALLINT NOT NULL CHECK (next_stage BETWEEN 1 AND 3),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_socratic_chat_state_owner ON socratic_chat_state(student_id,lecture_id);
