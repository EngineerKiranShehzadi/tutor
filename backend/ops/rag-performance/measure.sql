-- Existing saved learning-outcomes query, lecture 4/version 9; read-only.
-- On rag-hnsw-test: normal Run, then open EXPLAIN result tab.
-- No new embedding/API call. No forced planner settings. Do not call this an
-- HNSW measurement unless the plan actually names a matching HNSW index.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL jit = off;
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)
WITH q AS MATERIALIZED (
  SELECT question_embedding FROM public.rag_answer_memory
  WHERE lecture_id = 4 AND source_chat_history_id = 1912
    AND embedding_model_version = 'openai:text-embedding-3-small:1024'
    AND dataset_version_id = 9
  ORDER BY id DESC LIMIT 1
)
SELECT c.id, c.lecture_id, c.chunk_text,
       1 - (c.local_embedding <=> (SELECT question_embedding FROM q)) AS similarity
FROM public.lecture_qna_chunks c
WHERE c.lecture_id = 4 AND c.local_embedding IS NOT NULL
  AND (SELECT question_embedding FROM q) IS NOT NULL
  AND c.id IN (SELECT chunk_id FROM public.dataset_version_chunks WHERE version_id = 9)
ORDER BY c.local_embedding <=> (SELECT question_embedding FROM q)
LIMIT 15;
ROLLBACK;
-- Missing saved vector yields zero rows. Do not interpret that as retrieval failure.
-- Compare repeated runs in matched conditions; first-run cache state is unknown.
