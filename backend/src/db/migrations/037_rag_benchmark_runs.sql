-- 037: Aggregate-only evaluated RAG benchmark results, admin-only.
-- No raw student question, answer, gold label or retrieved chunk text persisted.
CREATE TABLE IF NOT EXISTS rag_benchmark_runs (
 id BIGSERIAL PRIMARY KEY,
 label VARCHAR(100) NOT NULL CHECK (length(btrim(label)) BETWEEN 3 AND 100),
 dataset_fingerprint CHAR(64) NOT NULL CHECK (dataset_fingerprint ~ '^[a-f0-9]{64}$'),
 prediction_fingerprint CHAR(64) NOT NULL CHECK (prediction_fingerprint ~ '^[a-f0-9]{64}$'),
 case_count INT NOT NULL CHECK (case_count BETWEEN 1 AND 2000),
 answerable_count INT NOT NULL CHECK(answerable_count BETWEEN 0 AND case_count),
 unsupported_count INT NOT NULL CHECK(unsupported_count BETWEEN 0 AND case_count),
 lecture_versions JSONB NOT NULL CHECK(jsonb_typeof(lecture_versions)='array'),
 metrics JSONB NOT NULL CHECK(jsonb_typeof(metrics)='object'),
 created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(answerable_count+unsupported_count=case_count),
 UNIQUE(dataset_fingerprint,prediction_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_rag_benchmark_runs_created ON rag_benchmark_runs(created_at DESC,id DESC);
