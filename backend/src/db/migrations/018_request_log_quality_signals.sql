-- Migration 018: quality signals on rag_request_log
-- Apply on its own, against a LOCAL database:
--   psql "<LOCAL db url>" -v ON_ERROR_STOP=1 --single-transaction -f src/db/migrations/018_request_log_quality_signals.sql
-- On Neon this must follow backend/ops/neon-migration/RUNBOOK.md (backup first).
--
-- memory_skip_reason: why a fact question did not use answer memory when that
-- was deliberate — 'PII_MASKED' (the question had personal data masked, and
-- masked questions can't be told apart in the cache). NULL otherwise, including
-- every route that never uses memory.
--
-- Additive and idempotent: one nullable column, nothing rewritten or backfilled.

ALTER TABLE rag_request_log ADD COLUMN IF NOT EXISTS memory_skip_reason TEXT;
