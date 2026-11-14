-- CLO-aware quiz generation uses ONLY explicitly approved mappings.
-- Existing lecture_learning_outcomes represents curriculum coverage and is not auto-approved.
CREATE TABLE IF NOT EXISTS approved_clo_lecture_scopes (
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecture_id INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  outcome_id BIGINT NOT NULL REFERENCES course_learning_outcomes(id) ON DELETE CASCADE,
  approved_by UUID NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lecture_id, outcome_id)
);
CREATE INDEX IF NOT EXISTS idx_approved_clo_scope_course ON approved_clo_lecture_scopes(course_id, lecture_id);
