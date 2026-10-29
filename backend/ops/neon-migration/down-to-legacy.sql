-- COMPENSATING ROLLBACK (use only if code is being rolled back AND the database has already been migrated
-- AND at least one dataset update has created extra chunk versions). Prefer restoring the backup if in doubt.
-- Needs separate approval at the time: it deletes cached answers that belong to non-live versions and chunks that
-- belong to no live version. Chat history is never touched; chunks still referenced by chat history/answer memory are kept.
BEGIN;

-- 1. Legacy code searches every chunk of a lecture, so only the active version's chunks may remain
--    (plus chunks still referenced by chat history so old answers keep their sources — they have no vector).
DELETE FROM lecture_qna_chunks c
WHERE c.qa_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE d.chunk_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM chat_history h WHERE c.id = ANY(h.source_chunk_ids));
UPDATE lecture_qna_chunks c SET local_embedding = NULL
WHERE NOT EXISTS (SELECT 1 FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE d.chunk_id = c.id);

-- 2. Answer memory back to its legacy key (lecture_content_hash). Rows of the live version get today's hash;
--    rows of other versions keep their older hash, which can no longer match (cache only — never served).
UPDATE rag_answer_memory m
SET lecture_content_hash = (SELECT md5(COALESCE(string_agg(c.id::text || ':' || md5(c.chunk_text), '|' ORDER BY c.id), ''))
                            FROM lecture_qna_chunks c WHERE c.lecture_id = m.lecture_id
                              AND EXISTS (SELECT 1 FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE d.chunk_id = c.id))
WHERE m.dataset_version_id = (SELECT active_version_id FROM lectures l WHERE l.id = m.lecture_id);
DELETE FROM rag_answer_memory WHERE lecture_content_hash IS NULL;
DROP INDEX IF EXISTS uniq_rag_memory_version_key;
DROP INDEX IF EXISTS idx_rag_memory_exact_lookup;
DROP INDEX IF EXISTS idx_rag_memory_semantic_scope;
ALTER TABLE rag_answer_memory DROP COLUMN IF EXISTS dataset_version_id;
ALTER TABLE rag_answer_memory ALTER COLUMN lecture_content_hash SET NOT NULL;
ALTER TABLE rag_answer_memory
  ADD CONSTRAINT rag_answer_memory_student_id_lecture_id_normalized_query_lectu_key
  UNIQUE (student_id, lecture_id, normalized_query, lecture_content_hash, embedding_model_version, answer_prompt_version);
CREATE INDEX IF NOT EXISTS idx_rag_memory_exact_lookup
  ON rag_answer_memory (student_id, lecture_id, normalized_query, lecture_content_hash, embedding_model_version, answer_prompt_version) WHERE cache_eligible = TRUE;
CREATE INDEX IF NOT EXISTS idx_rag_memory_semantic_scope
  ON rag_answer_memory (student_id, lecture_id, lecture_content_hash, embedding_model_version, answer_prompt_version) WHERE cache_eligible = TRUE;

-- 3. Version tables / pointer. (qa_id, content_hash, embedding_model_version columns on chunks are harmless and are KEPT,
--    so permanent Q&A ids survive a later re-deploy.)
ALTER TABLE lectures DROP COLUMN IF EXISTS active_version_id;
DROP TABLE IF EXISTS dataset_version_chunks;
DROP TABLE IF EXISTS dataset_versions;
COMMIT;
