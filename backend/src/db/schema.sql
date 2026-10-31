-- ─────────────────────────────────────────────
-- AskAITutor PostgreSQL Schema
-- Run: psql $DATABASE_URL -f src/db/schema.sql
-- ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT,
  is_verified   BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
-- Case-insensitive uniqueness, enforced by the database (see migration 012).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ── REFRESH TOKENS ─────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  family_id   UUID NOT NULL DEFAULT uuid_generate_v4(),  -- one per login, kept across rotations
  rotated_at  TIMESTAMPTZ,                                -- NULL = live; set = exchanged (kept for reuse detection)
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
-- family_id / expires_at indexes: migration 010 (this file also runs against
-- existing databases, where those columns do not exist until 010 has run).

-- ── PASSWORD RESET TOKENS (OTP-based) ──────────
-- State machine: unused → verified → used
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,          -- bcrypt of 6-digit OTP (cost 12)
  expires_at TIMESTAMPTZ NOT NULL,          -- now + 5 minutes
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  verified   BOOLEAN     NOT NULL DEFAULT FALSE,  -- true after OTP verified
  attempts   INT         NOT NULL DEFAULT 0,      -- wrong-guess counter, burns at 5
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens(user_id);

-- ── EMAIL VERIFICATION TOKENS (signup OTP) ─────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,          -- bcrypt of 6-digit OTP (cost 12)
  expires_at TIMESTAMPTZ NOT NULL,          -- now + 5 minutes
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  attempts   INT         NOT NULL DEFAULT 0,    -- wrong-guess counter, burns at 5
  ticket_hash TEXT,                             -- sha256 of the requesting browser's verify_ticket cookie
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evt_user_id ON email_verification_tokens(user_id);

-- ── AUTO-UPDATE updated_at ──────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
