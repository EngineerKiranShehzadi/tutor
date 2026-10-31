-- Refresh-token families, for rotation with reuse (theft) detection.
--   family_id   one per login; every rotation's successor keeps it.
--   rotated_at  NULL = the family's live token; set = already exchanged. Rotated
--               rows are kept (until they expire) so a replay of one is noticed
--               and the whole family is revoked.
-- Existing rows each become their own one-token family. Idempotent.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id  UUID NOT NULL DEFAULT uuid_generate_v4();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family  ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
