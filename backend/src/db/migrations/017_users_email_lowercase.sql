-- Stored emails are lowercase everywhere; 012's unique index on lower(email)
-- guarantees this cannot collide. Every lookup compares lower(email) with the
-- trimmed, lowercased input (auth.service.ts normEmail), so a row stored with
-- a capital letter (e.g. a hand-inserted admin) could log in even before this
-- runs; this keeps the stored value consistent too. Idempotent.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
