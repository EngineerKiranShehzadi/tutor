-- A14. Idempotent.
--
-- Dataset cleanup (dataset-version.service.ts purgeVersions) keeps every chunk
-- that a chat history entry or a cached answer still cites, asking for each
-- candidate chunk "does any row's source_chunk_ids contain this id?". Without
-- an index that is a full scan of both tables per candidate, inside the purge
-- transaction that runs right after every publish. GIN indexes on the arrays
-- serve the containment test (`source_chunk_ids @> ARRAY[id]`), which the purge
-- now uses (`id = ANY(source_chunk_ids)` cannot use an index).
CREATE INDEX IF NOT EXISTS idx_chat_history_source_chunks_gin
  ON chat_history USING GIN (source_chunk_ids);

CREATE INDEX IF NOT EXISTS idx_rag_memory_source_chunks_gin
  ON rag_answer_memory USING GIN (source_chunk_ids);
