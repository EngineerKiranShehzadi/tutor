-- 036: Approved course-outcome revision guidance, independent of grading/RAG.
-- Only a faculty/admin can publish a plan; students see it only with their own
-- graded evidence. Never auto-generate quizzes or assign academic standing.
CREATE TABLE IF NOT EXISTS approved_revision_plans (
  outcome_id BIGINT PRIMARY KEY REFERENCES course_learning_outcomes(id) ON DELETE CASCADE,
  lecture_id INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  guidance TEXT NOT NULL CHECK(length(btrim(guidance)) BETWEEN 15 AND 600),
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED')),
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status='APPROVED' AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
     OR (status='DRAFT' AND approved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_approved_revision_plans_lecture ON approved_revision_plans(lecture_id);
