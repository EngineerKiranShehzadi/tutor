-- Migration 003: Signup email verification OTP
-- Run: psql $DATABASE_URL -f src/db/migrations/003_email_verification_tokens.sql

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,          -- bcrypt of 5-digit OTP
  expires_at TIMESTAMPTZ NOT NULL,          -- now + 60s
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evt_user_id ON email_verification_tokens(user_id);
