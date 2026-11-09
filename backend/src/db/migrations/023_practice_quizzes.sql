
CREATE TABLE IF NOT EXISTS practice_quizzes (
  id BIGSERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecture_ids INT[] NOT NULL CHECK (cardinality(lecture_ids) > 0),
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'COMPLETED')),
  question_count INT NOT NULL CHECK (question_count BETWEEN 1 AND 50),
  correct_count INT CHECK (correct_count IS NULL OR correct_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_practice_quizzes_student ON practice_quizzes(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS practice_questions (
  id BIGSERIAL PRIMARY KEY,
  quiz_id BIGINT NOT NULL REFERENCES practice_quizzes(id) ON DELETE CASCADE,
  lecture_id INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  position INT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('FACTUAL', 'CONCEPTUAL', 'APPLICATION', 'REASONING')),
  question TEXT NOT NULL,
  options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4),
  correct_index INT NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  explanation TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_chunk_id INT REFERENCES lecture_qna_chunks(id) ON DELETE SET NULL,
  UNIQUE(quiz_id, position)
);
CREATE INDEX IF NOT EXISTS idx_practice_questions_quiz ON practice_questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS practice_answers (
  quiz_id BIGINT NOT NULL REFERENCES practice_quizzes(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES practice_questions(id) ON DELETE CASCADE,
  selected_index INT NOT NULL CHECK (selected_index BETWEEN 0 AND 3),
  is_correct BOOLEAN NOT NULL,
  PRIMARY KEY(quiz_id, question_id)
);
