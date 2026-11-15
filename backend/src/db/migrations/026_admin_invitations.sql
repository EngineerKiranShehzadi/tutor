-- 026_admin_invitations.sql
--
-- Inviting an admin who does not have an account yet.
--
-- Until now the only way to make someone an admin was to find them in the
-- user list and change their role, which means they had to sign up as a
-- student first and be told to do so out of band. Every system that manages
-- staff accounts invites by email instead, so this table holds an invitation
-- until the person it names appears.
--
-- One row per invited address. The row survives being accepted so the Admins
-- screen can show who invited whom and when, which is the record you want the
-- first time someone asks why a person has access.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS admin_invitations (
  id          SERIAL      PRIMARY KEY,
  -- Stored lower-cased and trimmed, the same normalisation the users table
  -- uses, or an invitation to "A@x.com" would never match a signup as
  -- "a@x.com".
  email       TEXT        NOT NULL,
  -- Who sent it. SET NULL rather than CASCADE: if that admin is later
  -- removed, the record of the invitation should outlive them.
  invited_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- NULL until the invited person has an account and the role was applied.
  accepted_at TIMESTAMPTZ,
  -- The user the invitation turned into, once accepted.
  accepted_by UUID        REFERENCES users(id) ON DELETE SET NULL
);

-- At most one invitation outstanding per address. A second invitation to the
-- same person updates the first rather than creating a duplicate that would
-- make "is there an invite for this email" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS admin_invitations_pending_email_key
  ON admin_invitations (email)
  WHERE accepted_at IS NULL;

-- The lookup done on every signup: is there a live invitation for this address?
CREATE INDEX IF NOT EXISTS admin_invitations_pending_idx
  ON admin_invitations (email, expires_at)
  WHERE accepted_at IS NULL;
