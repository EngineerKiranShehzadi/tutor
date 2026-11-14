-- P1: Enforce approved lecture/CLO course integrity at the database layer.
-- Additive and idempotent; existing approvals remain unchanged.
-- Explicit trigger avoids assuming composite uniqueness on legacy courses/lectures.
CREATE OR REPLACE FUNCTION enforce_approved_clo_course_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lectures l
    JOIN course_learning_outcomes o ON o.id=NEW.outcome_id
    WHERE l.id=NEW.lecture_id
      AND l.course_id=NEW.course_id
      AND o.course_id=NEW.course_id
  ) THEN
    RAISE EXCEPTION 'Approved CLO mapping must belong to the same course'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS approved_clo_course_scope_guard ON approved_clo_lecture_scopes;
CREATE TRIGGER approved_clo_course_scope_guard
BEFORE INSERT OR UPDATE OF course_id,lecture_id,outcome_id
ON approved_clo_lecture_scopes
FOR EACH ROW EXECUTE FUNCTION enforce_approved_clo_course_scope();

-- Fail migration if old rows already violate the intended invariant.
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM approved_clo_lecture_scopes s
  LEFT JOIN lectures l ON l.id=s.lecture_id
  LEFT JOIN course_learning_outcomes o ON o.id=s.outcome_id
  WHERE l.id IS NULL OR o.id IS NULL
    OR l.course_id IS DISTINCT FROM s.course_id
    OR o.course_id IS DISTINCT FROM s.course_id
 ) THEN
  RAISE EXCEPTION 'Existing approved CLO scopes violate course consistency; repair before proceeding';
 END IF;
END $$;
