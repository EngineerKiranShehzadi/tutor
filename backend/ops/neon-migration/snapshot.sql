-- Deterministic fingerprint of everything the migration must not disturb. Read-only.
-- Run against the source before, and against any restored/migrated copy after; the legacy-table rows must be identical.
SELECT 'lectures'               AS tbl, count(*) AS n, md5(string_agg(id || ':' || title || ':' || status, '|' ORDER BY id)) AS fingerprint FROM lectures
UNION ALL SELECT 'lecture_qna_chunks (text)', count(*), md5(string_agg(id || ':' || md5(chunk_text) || ':' || md5(question || answer), '|' ORDER BY id)) FROM lecture_qna_chunks
UNION ALL SELECT 'lecture_qna_chunks (vectors)', count(*), md5(string_agg(id || ':' || md5(local_embedding::text), '|' ORDER BY id)) FROM lecture_qna_chunks WHERE local_embedding IS NOT NULL
UNION ALL SELECT 'chat_history', count(*), md5(string_agg(id || ':' || md5(question || answer) || ':' || coalesce(source_chunk_ids::text, ''), '|' ORDER BY id)) FROM chat_history
UNION ALL SELECT 'chat_sessions', count(*), md5(string_agg(id || ':' || title, '|' ORDER BY id)) FROM chat_sessions
UNION ALL SELECT 'rag_answer_memory', count(*), md5(string_agg(id || ':' || normalized_query || ':' || md5(answer) || ':' || source_chunk_ids::text, '|' ORDER BY id)) FROM rag_answer_memory
UNION ALL SELECT 'lecture_agent_profiles', count(*), md5(string_agg(lecture_id || ':' || agent_name || ':' || md5(instructions), '|' ORDER BY lecture_id)) FROM lecture_agent_profiles
UNION ALL SELECT 'student_questions', count(*), md5(string_agg(id || ':' || md5(question), '|' ORDER BY id)) FROM student_questions
UNION ALL SELECT 'users (ids)', count(*), md5(string_agg(id::text, '|' ORDER BY id)) FROM users
ORDER BY 1;
