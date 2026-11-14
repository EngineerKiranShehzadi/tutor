-- 033: Faculty-governed learning outcomes. Additive: no changes to existing RAG data.
-- Outcome evidence is counted only when a faculty member explicitly maps a quiz question.
CREATE TABLE IF NOT EXISTS course_learning_outcomes (
  id BIGSERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code VARCHAR(32) NOT NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 5 AND 1000),
  external_guid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_id,code),
  UNIQUE(id,course_id),
  CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$')
);
CREATE INDEX IF NOT EXISTS idx_learning_outcomes_course ON course_learning_outcomes(course_id);
-- Lecture-CLO association is instructional coverage, NOT proof of individual-question mastery.
CREATE TABLE IF NOT EXISTS lecture_learning_outcomes (
  lecture_id INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  outcome_id BIGINT NOT NULL REFERENCES course_learning_outcomes(id) ON DELETE CASCADE,
  PRIMARY KEY(lecture_id,outcome_id)
);
CREATE INDEX IF NOT EXISTS idx_lecture_outcomes_outcome ON lecture_learning_outcomes(outcome_id);
-- A verified quiz question needs a specific faculty-approved outcome tag before it counts.
CREATE TABLE IF NOT EXISTS practice_question_outcomes (
  question_id BIGINT PRIMARY KEY REFERENCES practice_questions(id) ON DELETE CASCADE,
  outcome_id BIGINT NOT NULL REFERENCES course_learning_outcomes(id) ON DELETE CASCADE,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_question_outcomes_outcome ON practice_question_outcomes(outcome_id);
