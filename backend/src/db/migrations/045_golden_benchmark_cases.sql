-- 045: Reviewed golden benchmark CASES (the question bank), admin-managed.
-- Distinct from rag_benchmark_runs (037), which stores scored RUN aggregates.
-- A case is drafted from a pinned dataset version's own chunks, reviewed by a
-- human, and only then exported as benchmark truth. Expected evidence comes
-- from SOURCE chunk IDs, never from retrieval output.
CREATE TABLE IF NOT EXISTS golden_benchmark_cases (
  id                 BIGSERIAL PRIMARY KEY,
  -- Stable, reproducible per-version identifier (e.g. "L2-V13-ab12cd"). Used as
  -- the case `id` in exported gold.json; unique within a dataset version.
  case_key           VARCHAR(80) NOT NULL CHECK (case_key ~ '^[A-Za-z0-9._-]{1,80}$'),
  lecture_id         INT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  -- Pins the corpus/dataset version the case was grounded in. A new version
  -- gets its own cases; approved cases are never silently rewritten.
  dataset_version_id INT NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  question           TEXT NOT NULL CHECK (length(btrim(question)) BETWEEN 5 AND 2000),
  expected_answer    TEXT,
  -- Faculty-reviewed positive evidence chunk IDs. Empty for unsupported cases.
  expected_chunk_ids INT[] NOT NULL DEFAULT '{}',
  -- Provenance: the chunk(s) the draft was drawn from (kept distinct so a review
  -- can narrow expected evidence without losing where the case came from).
  source_chunk_ids   INT[] NOT NULL DEFAULT '{}',
  category           VARCHAR(20) NOT NULL DEFAULT 'factual'
                     CHECK (category IN ('factual','conceptual','comparison','compound','follow_up','unsupported','ambiguous','keyword','paraphrase')),
  answerable         BOOLEAN NOT NULL DEFAULT TRUE,
  review_status      VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
                     CHECK (review_status IN ('DRAFT','APPROVED','REJECTED','NEEDS_EVIDENCE')),
  -- How the draft was produced, e.g. 'DETERMINISTIC_CHUNK'. LLM-generated drafts
  -- must still be reviewed before they become benchmark-eligible.
  generation_method  VARCHAR(40) NOT NULL DEFAULT 'DETERMINISTIC_CHUNK',
  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Unsupported cases must carry no expected evidence; answerable cases must,
  -- once approved, have at least one expected chunk (enforced at review time in
  -- the service — kept flexible here so a DRAFT can be saved while evidence is
  -- still being selected).
  CONSTRAINT golden_case_unsupported_has_no_evidence
    CHECK (answerable OR cardinality(expected_chunk_ids) = 0),
  UNIQUE (dataset_version_id, case_key)
);

CREATE INDEX IF NOT EXISTS idx_golden_cases_version_status
  ON golden_benchmark_cases (dataset_version_id, review_status, id);
CREATE INDEX IF NOT EXISTS idx_golden_cases_lecture
  ON golden_benchmark_cases (lecture_id);
