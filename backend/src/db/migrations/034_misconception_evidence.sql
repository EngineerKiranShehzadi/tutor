-- 034: Faculty-approved misconception labels and option mappings, English-only.
-- Quiz answers already provide durable, deterministic history; no inferred diagnosis.
CREATE TABLE IF NOT EXISTS learning_misconceptions (
 id BIGSERIAL PRIMARY KEY,
 outcome_id BIGINT NOT NULL REFERENCES course_learning_outcomes(id) ON DELETE CASCADE,
 code VARCHAR(40) NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
 description TEXT NOT NULL CHECK(length(btrim(description)) BETWEEN 8 AND 600),
 UNIQUE(outcome_id,code), UNIQUE(id,outcome_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_misconceptions_outcome ON learning_misconceptions(outcome_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_question_outcome_composite
 ON practice_question_outcomes(question_id,outcome_id);
CREATE TABLE IF NOT EXISTS practice_distractor_misconceptions (
 question_id BIGINT NOT NULL,
 selected_index INT NOT NULL CHECK(selected_index BETWEEN 0 AND 3),
 outcome_id BIGINT NOT NULL,
 misconception_id BIGINT NOT NULL,
 mapped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(question_id,selected_index),
 FOREIGN KEY(question_id,outcome_id) REFERENCES practice_question_outcomes(question_id,outcome_id) ON DELETE CASCADE,
 FOREIGN KEY(misconception_id,outcome_id) REFERENCES learning_misconceptions(id,outcome_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_distractor_misconception_id ON practice_distractor_misconceptions(misconception_id);
