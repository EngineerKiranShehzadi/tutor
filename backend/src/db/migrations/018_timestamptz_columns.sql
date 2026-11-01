-- 018. Idempotent.
--
-- Five columns were created as `timestamp without time zone` while the rest of
-- the schema uses `timestamptz`. CURRENT_TIMESTAMP stores the UTC wall-clock
-- numbers into them and the zone is discarded, so every reader assumes its own
-- local time: in Pakistan (UTC+5) chat messages and admin rows display five
-- hours early. chat_sessions is already timestamptz, which is why the sidebar's
-- relative times were correct while the message times were not.
--
-- Converting the column relabels the same instant; no value is changed, nothing
-- is deleted. The USING clause states what the stored numbers already are
-- (UTC). Columns already converted are skipped, so this is safe to re-run on
-- any server regardless of its session TimeZone.
--
-- Note: ALTER COLUMN ... TYPE rewrites the table and takes a brief exclusive
-- lock. lecture_qna_chunks is the largest (~19 MB). Do not run during a
-- dataset upload.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type    = 'timestamp without time zone'
       AND (table_name, column_name) IN (
             ('chat_history',       'created_at'),
             ('lecture_qna_chunks', 'created_at'),
             ('lectures',           'created_at'),
             ('lectures',           'updated_at'),
             ('student_questions',  'created_at'))
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      r.table_name, r.column_name, r.column_name);
    RAISE NOTICE 'converted %.% to timestamptz', r.table_name, r.column_name;
  END LOOP;
END $$;
