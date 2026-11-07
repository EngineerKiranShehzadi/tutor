-- Run AFTER reapplying 022 to ensure nothing was reassigned.
DO $$
DECLARE
 default_id INT;
 other_id INT;
BEGIN
 SELECT id INTO default_id FROM courses WHERE legacy_key = 'original-playlist';
 SELECT id INTO other_id FROM courses WHERE title = 'Python Programming';
 IF (SELECT COUNT(*) FROM courses WHERE legacy_key='original-playlist') <> 1 THEN RAISE EXCEPTION 'Duplicate legacy course'; END IF;
 IF (SELECT course_id FROM lectures WHERE title = 'Python Intro') <> other_id THEN RAISE EXCEPTION 'New lecture was reassigned'; END IF;
 IF (SELECT COUNT(*) FROM lectures WHERE course_id=default_id) <> 8 THEN RAISE EXCEPTION 'Legacy records changed'; END IF;
END;
$$;
