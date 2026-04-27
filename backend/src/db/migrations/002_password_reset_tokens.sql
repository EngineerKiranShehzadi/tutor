-- Migration 002: OTP-based password reset
-- Run: psql $DATABASE_URL -f src/db/migrations/002_password_reset_tokens.sql

-- Remove legacy link-based reset columns
ALTER TABLE users DROP COLUMN IF EXISTS reset_token_hash;
ALTER TABLE users DROP COLUMN IF EXISTS reset_token_expires;
DROP INDEX IF EXISTS idx_users_reset_token;

-- Create OTP token table (state machine: unused → verified → used)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,          -- bcrypt of 5-digit OTP
  expires_at TIMESTAMPTZ NOT NULL,          -- now + 60s
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  verified   BOOLEAN     NOT NULL DEFAULT FALSE,  -- set after OTP verified
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens(user_id);
