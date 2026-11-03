-- Hybrid search, part 1 (S-R1 / Finding 2 of the 2026-11-03 RAG test): adds
-- Postgres full-text search alongside the existing pgvector dense search.
-- Idempotent.
--
-- Dense embeddings alone are weak at distinguishing near-duplicate phrasing
-- that differs only in a number or name ("slide 14" vs "slide 15"), which is
-- exactly the shape of a recurring question family in these lectures
-- ("What is covered on slide N?"). A lexical signal running in parallel and
-- fused with the vector results (see fulltext-search.service.ts /
-- vector-search.service.ts searchChunksHybrid) catches exact-token matches
-- dense search misses.
--
-- search_vector is a STORED generated column (computed once on write, not on
-- every query) over the same fields already embedded into chunk_text
-- (question, answer, keywords) — 'A' weight on question (it's the part a
-- student's own wording usually echoes), 'B' on answer and keywords.
ALTER TABLE lecture_qna_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(question, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(answer, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(keywords, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_search_vector
  ON lecture_qna_chunks USING GIN (search_vector);
