-- Migration 028: health check history (observability)
--
-- Apply with the project's own runner, which records it in schema_migrations:
--   npm run db:migrate
--
-- Why this table exists.
--
-- /health/ready answers "is every dependency up right now". It keeps no
-- history, so a service that failed at 2am and recovered by 9am left no trace
-- anywhere: the System Health page would show five green rows and there was no
-- way to know anything had happened. That is the difference between a status
-- check and monitoring. One row per component per poll is written here by the
-- maintenance scheduler, which is what lets the page report uptime over a
-- window and the time of the last failure.
--
-- latency_ms is NULLABLE on purpose. checkReadiness() reports 0 both for a
-- probe that failed and for a provider that is configured but has no free
-- probe to time. Storing that 0 would make a service that never responded
-- indistinguishable from one that answered instantly, and would drag any
-- average down with a measurement that never happened. Nothing measured is
-- stored as NULL, so averages ignore it instead of counting it as zero.
--
-- status mirrors health.service.ts ComponentStatus exactly:
--   healthy    the probe ran and passed
--   degraded   the probe could not be run (e.g. UNVERIFIED_PROVIDER) — not a fault
--   unhealthy  the probe ran and failed, or the component is misconfigured
-- Uptime is therefore counted over healthy + unhealthy only; see the service.
--
-- Additive and idempotent: creates one new table and its indexes. No existing
-- table, row or embedding is read, rewritten or deleted.

CREATE TABLE IF NOT EXISTS health_check_log (
  id         BIGSERIAL   PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- database | pgvector | embeddingServer | reranker | answerLlm. Deliberately
  -- not an enum or a foreign key: health.service.ts owns this list, and adding
  -- a component there must not require a migration here.
  component  TEXT        NOT NULL,
  status     TEXT        NOT NULL,
  latency_ms INT,
  error_code TEXT
);

-- The page's two queries are both "this component, newest first, within a
-- window", which is exactly this index.
CREATE INDEX IF NOT EXISTS health_check_log_component_time_idx
  ON health_check_log (component, checked_at DESC);

-- Retention deletes by age across every component, so it gets its own index
-- rather than scanning the one above.
CREATE INDEX IF NOT EXISTS health_check_log_time_idx
  ON health_check_log (checked_at);
