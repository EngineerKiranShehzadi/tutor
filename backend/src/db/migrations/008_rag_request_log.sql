-- Migration 008: RAG request log + alert state (observability)
-- Apply on its own, against a LOCAL database:
--   psql "<LOCAL db url>" -v ON_ERROR_STOP=1 --single-transaction -f src/db/migrations/008_rag_request_log.sql
-- On Neon this must follow backend/ops/neon-migration/RUNBOOK.md (backup first).
--
-- rag_request_log: one row per RAG request, keyed by the same 32-hex OTel
-- trace ID used in logs, chat_history and Phoenix. It holds only metadata
-- (route, outcome, per-stage timings, token counts, estimated cost) — never
-- raw question/answer text — so the admin dashboard can query request-level
-- history from Postgres without depending on Phoenix being reachable.
--
-- chat_history.trace_id: links a stored chat turn back to its request log
-- row / Phoenix trace. Nullable; existing rows stay NULL.
--
-- observability_alert_state: last-fired time and value per alert rule, so
-- alerts can honour a cooldown across restarts.
--
-- Additive and idempotent: only creates new tables/indexes and adds one
-- nullable column. Nothing is deleted, rewritten or backfilled, and no
-- existing data (including embeddings) is touched.

CREATE TABLE IF NOT EXISTS rag_request_log (
  id                          BIGSERIAL PRIMARY KEY,
  trace_id                    CHAR(32) NOT NULL UNIQUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  student_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
  lecture_id                  INT REFERENCES lectures(id) ON DELETE SET NULL,
  session_id                  INT,
  route                       TEXT,
  status                      TEXT NOT NULL,       -- SUCCESS | ERROR
  response_status             TEXT,                -- ANSWERED, NOT_FOUND, GUARDRAIL_REJECTED, ...
  not_found_reason            TEXT,
  error_code                  TEXT,
  memory_result               TEXT,
  answer_verification_reason  TEXT,
  total_ms                    INT NOT NULL,
  stage_ms                    JSONB,
  llm_calls                   INT NOT NULL DEFAULT 0,
  input_tokens                INT,
  output_tokens               INT,
  est_cost_usd                NUMERIC(10,6),
  llm_model                   TEXT,
  exported_to_phoenix         BOOLEAN NOT NULL DEFAULT FALSE,
  schema_version              TEXT
);

CREATE INDEX IF NOT EXISTS idx_rag_request_log_created
  ON rag_request_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_request_log_lecture_created
  ON rag_request_log (lecture_id, created_at DESC);

-- Failed / not-answered requests only: keeps "recent problems" queries cheap.
CREATE INDEX IF NOT EXISTS idx_rag_request_log_problems
  ON rag_request_log (created_at DESC)
  WHERE status = 'ERROR'
     OR response_status NOT IN ('ANSWERED', 'MEMORY_HIT_ANSWERED', 'GREETING_ANSWERED', 'SUMMARY_ANSWERED');

ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS trace_id CHAR(32);

CREATE INDEX IF NOT EXISTS idx_chat_history_trace_id
  ON chat_history (trace_id);

CREATE TABLE IF NOT EXISTS observability_alert_state (
  rule           TEXT PRIMARY KEY,
  last_fired_at  TIMESTAMPTZ,
  last_value     NUMERIC
);
