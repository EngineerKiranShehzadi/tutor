-- Disposable DB regression fixture. No production / student PII.
BEGIN;
INSERT INTO users(id,name,email,password_hash) VALUES
('00000000-0000-4000-8000-000000000001','A','evidence-a@example.invalid','offline'),
('00000000-0000-4000-8000-000000000002','B','evidence-b@example.invalid','offline');
INSERT INTO courses(id,title) VALUES(90001,'Learning Evidence Fixture');
INSERT INTO lectures(id,course_id,title,youtube_url)
VALUES(90001,90001,'Evidence Lesson','https://www.youtube.com/watch?v=abc123def45');
INSERT INTO course_learning_outcomes(id,course_id,code,description)
VALUES(90001,90001,'CLO1','Differentiate precision and recall'),
      (90002,90001,'CLO2','Explain the use of vector search');
INSERT INTO learning_misconceptions(id,outcome_id,code,description)
VALUES(90001,90001,'SWAPPED','Confuses precision with recall'),
      (90002,90002,'OTHER','Makes an unrelated assumption');
INSERT INTO practice_quizzes(id,student_id,course_id,lecture_ids,status,question_count,correct_count,submitted_at)
VALUES(90001,'00000000-0000-4000-8000-000000000001',90001,'{90001}','COMPLETED',1,0,NOW()),
      (90002,'00000000-0000-4000-8000-000000000002',90001,'{90001}','COMPLETED',1,1,NOW());
INSERT INTO practice_questions(id,quiz_id,lecture_id,position,category,question,options,correct_index,explanation,source_label)
VALUES(90001,90001,90001,1,'FACTUAL','What is precision?','["A","B","C","D"]'::jsonb,0,'Correct','Example'),
      (90002,90002,90001,1,'FACTUAL','What is precision?','["A","B","C","D"]'::jsonb,0,'Correct','Example');
INSERT INTO practice_question_outcomes(question_id,outcome_id) VALUES(90001,90001),(90002,90001);
INSERT INTO practice_distractor_misconceptions(question_id,selected_index,outcome_id,misconception_id)
VALUES(90001,1,90001,90001);
INSERT INTO practice_answers(quiz_id,question_id,selected_index,is_correct)
VALUES(90001,90001,1,FALSE),(90002,90002,0,TRUE);

DO $$
DECLARE a_count INT; b_count INT; timeline_a INT; timeline_b INT;
BEGIN
 SELECT COUNT(*) INTO a_count FROM practice_distractor_misconceptions dm
 JOIN practice_questions q ON q.id=dm.question_id
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.status='COMPLETED'
 JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id AND a.selected_index=dm.selected_index AND a.is_correct=FALSE
 WHERE z.student_id='00000000-0000-4000-8000-000000000001';
 SELECT COUNT(*) INTO b_count FROM practice_distractor_misconceptions dm
 JOIN practice_questions q ON q.id=dm.question_id
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.status='COMPLETED'
 JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id AND a.selected_index=dm.selected_index AND a.is_correct=FALSE
 WHERE z.student_id='00000000-0000-4000-8000-000000000002';
 IF a_count<>1 OR b_count<>0 THEN RAISE EXCEPTION 'Student signal isolation failed'; END IF;
 SELECT COUNT(*) INTO timeline_a FROM practice_answers a JOIN practice_quizzes z ON z.id=a.quiz_id WHERE z.student_id='00000000-0000-4000-8000-000000000001';
 SELECT COUNT(*) INTO timeline_b FROM practice_answers a JOIN practice_quizzes z ON z.id=a.quiz_id WHERE z.student_id='00000000-0000-4000-8000-000000000002';
 IF timeline_a<>1 OR timeline_b<>1 THEN RAISE EXCEPTION 'Timeline ownership fixture failed'; END IF;
 -- A mismatched misconception/outcome tag must fail the composite FK.
 BEGIN
  INSERT INTO practice_distractor_misconceptions(question_id,selected_index,outcome_id,misconception_id)
  VALUES(90001,2,90001,90002);
  RAISE EXCEPTION 'Cross-outcome tag unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
ROLLBACK;
