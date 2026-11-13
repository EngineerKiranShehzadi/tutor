-- Real PostgreSQL/pgvector isolation contract, run only on ephemeral CI DB.
-- Transaction rollback ensures no fixtures remain after this test.
BEGIN;
DO $$
DECLARE
  student_a UUID;
  student_b UUID;
  course_a BIGINT;
  course_b BIGINT;
  sample_embedding vector(1024);
  n INT;
BEGIN
  INSERT INTO users(name,email,password_hash,role,is_verified)
  VALUES ('Personal RAG A','youtube-isolation-a@example.invalid','test-only','STUDENT',true)
  RETURNING id INTO student_a;
  INSERT INTO users(name,email,password_hash,role,is_verified)
  VALUES ('Personal RAG B','youtube-isolation-b@example.invalid','test-only','STUDENT',true)
  RETURNING id INTO student_b;

  INSERT INTO student_youtube_courses(student_id,playlist_id,title,status)
  VALUES(student_a,'PL_isolation_0000000001','A private course','READY')
  RETURNING id INTO course_a;
  INSERT INTO student_youtube_courses(student_id,playlist_id,title,status)
  VALUES(student_b,'PL_isolation_0000000001','B private course','READY')
  RETURNING id INTO course_b;
  IF course_a=course_b THEN RAISE EXCEPTION 'Personal course ownership not isolated'; END IF;

  INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status)
  VALUES(course_a,'abcdefghijk','A video',1,'READY');
  INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status)
  VALUES(course_b,'abcdefghijk','B video',1,'READY');

  sample_embedding:=('['||'1,'||repeat('0,',1022)||'0]')::vector(1024);
  INSERT INTO student_youtube_course_chunks
    (course_id,video_id,chunk_index,question,answer,chunk_text,start_time,end_time,embedding_model_version,local_embedding)
  VALUES(course_a,'abcdefghijk',0,'Question A','Secret student A evidence','Student A private transcript',
         '00:00:01.000','00:00:03.000','test:1024',sample_embedding);
  INSERT INTO student_youtube_course_chunks
    (course_id,video_id,chunk_index,question,answer,chunk_text,start_time,end_time,embedding_model_version,local_embedding)
  VALUES(course_b,'abcdefghijk',0,'Question B','Student B evidence','Student B private transcript',
         '00:00:01.000','00:00:03.000','test:1024',sample_embedding);

  -- Same owner filter used in personal-youtube-rag.service.ts retrieval.
  SELECT COUNT(*) INTO n FROM student_youtube_course_chunks k
  JOIN student_youtube_course_videos v ON v.course_id=k.course_id AND v.video_id=k.video_id
  JOIN student_youtube_courses c ON c.id=k.course_id
  WHERE c.student_id=student_b AND c.id=course_a;
  IF n<>0 THEN RAISE EXCEPTION 'Cross-student evidence exposed'; END IF;

  SELECT COUNT(*) INTO n FROM student_youtube_course_chunks k
  JOIN student_youtube_course_videos v ON v.course_id=k.course_id AND v.video_id=k.video_id
  JOIN student_youtube_courses c ON c.id=k.course_id
  WHERE c.student_id=student_a AND c.id=course_a;
  IF n<>1 THEN RAISE EXCEPTION 'Owner evidence not found'; END IF;

  -- The service's owner-scoped delete must not delete another student's course.
  DELETE FROM student_youtube_courses WHERE id=course_a AND student_id=student_b;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'Cross-student delete was allowed'; END IF;

  DELETE FROM student_youtube_courses WHERE id=course_a AND student_id=student_a;
  SELECT COUNT(*) INTO n FROM student_youtube_course_chunks WHERE course_id=course_a;
  IF n<>0 THEN RAISE EXCEPTION 'Private chunks not cascaded on deletion'; END IF;
  SELECT COUNT(*) INTO n FROM student_youtube_course_videos WHERE course_id=course_a;
  IF n<>0 THEN RAISE EXCEPTION 'Private videos not cascaded on deletion'; END IF;
  SELECT COUNT(*) INTO n FROM student_youtube_course_chunks WHERE course_id=course_b;
  IF n<>1 THEN RAISE EXCEPTION 'Deleting A removed B evidence'; END IF;

  RAISE NOTICE 'Personal YouTube course ownership, vector storage, and cascade checks passed';
END $$;
ROLLBACK;
