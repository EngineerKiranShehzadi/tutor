-- Wrong-guess counter for both OTP tables. A code is burned (used = TRUE) after
-- 5 wrong guesses, so a 6-digit code cannot be brute-forced inside its lifetime.
-- Idempotent.
ALTER TABLE password_reset_tokens     ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
