-- Case-insensitive uniqueness for users.email. The plain UNIQUE constraint only
-- holds because every code path lowercases first; this makes the database
-- enforce it, so one future non-lowercased insert cannot create a case-variant
-- duplicate. Fails loudly (and changes nothing) if such duplicates already
-- exist — resolve them by hand first. Idempotent.
DO $$
DECLARE dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'users has % email(s) that differ only by case; merge them before applying 012', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
