-- Student-owned YouTube quizzes are deliberately separate from admin
-- course quiz records and never appear in another student's history.
CREATE TABLE IF NOT EXISTS student_youtube_practice_quizzes (
  id BIGSERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id BIGINT NOT NULL REFERENCES student_youtube_courses(id) ON DELETE CASCADE,
  video_ids TEXT[] NOT NULL CHECK(cardinality(video_ids) BETWEEN 1 AND 2),
  status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','COMPLETED')),
  question_count INT NOT NULL CHECK(question_count BETWEEN 1 AND 20),
  correct_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_quiz_owner
 ON student_youtube_practice_quizzes(student_id,created_at DESC);
CREATE TABLE IF NOT EXISTS student_youtube_practice_questions (
  id BIGSERIAL PRIMARY KEY,
  quiz_id BIGINT NOT NULL REFERENCES student_youtube_practice_quizzes(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  video_title TEXT NOT NULL,
  position INT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('FACTUAL','CONCEPTUAL','APPLICATION','REASONING')),
  question TEXT NOT NULL,
  options JSONB NOT NULL CHECK(jsonb_typeof(options)='array' AND jsonb_array_length(options)=4),
  correct_index INT NOT NULL CHECK(correct_index BETWEEN 0 AND 3),
  explanation TEXT NOT NULL,
  source_label TEXT NOT NULL,
  UNIQUE(quiz_id,position)
);
CREATE INDEX IF NOT EXISTS idx_student_youtube_quiz_questions
 ON student_youtube_practice_questions(quiz_id,position);
CREATE TABLE IF NOT EXISTS student_youtube_practice_answers (
  quiz_id BIGINT NOT NULL REFERENCES student_youtube_practice_quizzes(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES student_youtube_practice_questions(id) ON DELETE CASCADE,
  selected_index INT NOT NULL CHECK(selected_index BETWEEN 0 AND 3),
  is_correct BOOLEAN NOT NULL,
  PRIMARY KEY(quiz_id,question_id)
);
