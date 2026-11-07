-- Run AFTER migration 022, on a throwaway PG. Abort on any regression.
DO $$
DECLARE
  default_id INT;
  other_id INT;
BEGIN
  SELECT id INTO default_id FROM courses WHERE legacy_key = 'original-playlist';
  IF default_id IS NULL THEN RAISE EXCEPTION 'Legacy course missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM courses WHERE id = default_id
    AND title = 'Generative AI Fundamentals'
    AND subtitle = 'Master the Art of AI Conversations using ChatGPT'
  ) THEN RAISE EXCEPTION 'Legacy course title/subtitle incorrect'; END IF;
  IF (SELECT COUNT(*) FROM lectures) != 7 THEN RAISE EXCEPTION 'Legacy lecture count changed'; END IF;
  IF EXISTS (SELECT 1 FROM lectures WHERE course_id <> default_id OR course_id IS NULL) THEN
    RAISE EXCEPTION 'Legacy lecture mapping incorrect';
  END IF;
  IF (SELECT COUNT(DISTINCT youtube_video_id) FROM lectures) != 7 THEN
    RAISE EXCEPTION 'YouTube IDs were changed';
  END IF;
  INSERT INTO courses (title, subtitle) VALUES ('Python Programming','Learn Python')
    RETURNING id INTO other_id;
  INSERT INTO lectures (title, youtube_url, course_id)
    VALUES ('Python Intro', '', other_id);
  IF (SELECT course_id FROM lectures WHERE title = 'Python Intro') != other_id THEN
    RAISE EXCEPTION 'New lecture assigned to wrong course';
  END IF;
  INSERT INTO lectures (title, youtube_url) VALUES ('Legacy API Insert', '');
  IF (SELECT course_id FROM lectures WHERE title = 'Legacy API Insert') != default_id THEN
    RAISE EXCEPTION 'Legacy insert compatibility failed';
  END IF;
END;
$$;
