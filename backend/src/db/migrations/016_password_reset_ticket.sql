-- Binds a verified password-reset code to the browser that verified it.
-- ticket_hash = sha256 of a random ticket held only in that browser's
-- httpOnly reset_ticket cookie. resetPassword requires it, so knowing the
-- email address alone can no longer complete someone else's reset in the
-- minutes after they verified their code. Rows from before this migration
-- have NULL and match nothing (the user just requests a new code).
-- Idempotent.
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS ticket_hash TEXT;
