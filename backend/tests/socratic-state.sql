-- Discard every row at end of test. No contact with production Neon.
BEGIN;
INSERT INTO users(id,name,email,password_hash) VALUES
('00000000-0000-4000-8000-000000000011','Socratic A','socratic-a@example.invalid','offline'),
('00000000-0000-4000-8000-000000000012','Socratic B','socratic-b@example.invalid','offline');
INSERT INTO courses(id,title) VALUES(94001,'Socratic fixture');
INSERT INTO lectures(id,course_id,title,youtube_url) VALUES
(94001,94001,'Grounded Questions','https://www.youtube.com/watch?v=abc123def45');
INSERT INTO chat_sessions(id,student_id,lecture_id,title) VALUES
(94001,'00000000-0000-4000-8000-000000000011',94001,'New Chat'),
(94002,'00000000-0000-4000-8000-000000000012',94001,'New Chat');
INSERT INTO socratic_chat_state(session_id,student_id,lecture_id,anchor_question,next_stage)
VALUES(94001,'00000000-0000-4000-8000-000000000011',94001,'Explain precision?',1);
DO $$
DECLARE a integer;b integer;
BEGIN
 SELECT COUNT(*) INTO a FROM socratic_chat_state WHERE session_id=94001
 AND student_id='00000000-0000-4000-8000-000000000011' AND lecture_id=94001;
 SELECT COUNT(*) INTO b FROM socratic_chat_state WHERE session_id=94001
 AND student_id='00000000-0000-4000-8000-000000000012';
 IF a<>1 OR b<>0 THEN RAISE EXCEPTION 'Cross-student state read'; END IF;
 BEGIN
  INSERT INTO socratic_chat_state(session_id,student_id,lecture_id,anchor_question,next_stage)
  VALUES(94002,'00000000-0000-4000-8000-000000000012',94001,'Invalid state',4);
  RAISE EXCEPTION 'Invalid stage accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
DELETE FROM chat_sessions WHERE id=94001;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM socratic_chat_state WHERE session_id=94001) THEN
  RAISE EXCEPTION 'Socratic chat state did not cascade';
 END IF;
END $$;
ROLLBACK;
