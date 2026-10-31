-- Binds each email-verification code to the browser that asked for it.
-- ticket_hash = sha256 of a random ticket held only in that browser's httpOnly
-- verify_ticket cookie. Resend and verify require it, so a code mailed for an
-- account someone else created (with a password they chose) cannot be used by
-- the inbox owner to verify that account by accident. Rows from before this
-- migration have NULL and match nothing; logging in again re-binds them.
-- Idempotent.
ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS ticket_hash TEXT;
