#!/usr/bin/env bash
# Full dry-run of the Neon plan on LOCAL containers — never touches Neon.
#   STAND_IN = local copy of the live data (docker pg16 :55432, db askai_legacy)  -> acts as "live"
#   scratch  = docker pg17 :55433 (same major version as Neon)
# Needs the original code checked out for the legacy-code checks: BASELINE_BACKEND=<path to backend of the commit before this branch>.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"; R="${REHEARSAL_OUT:-/tmp/askai-rehearsal}"; rm -rf "$R"; mkdir -p "$R"
export PGPASSWORD=test
P17="psql -h localhost -p 55433 -U postgres"
STAND_IN=postgresql://postgres:test@localhost:55432/askai_legacy
SCR=postgresql://postgres:test@localhost:55433
step() { echo; echo "######## $*"; }

step "1. backup + fingerprint of the stand-in 'live' database"
ops/neon-migration/backup.sh "$STAND_IN" "$R/backup" | grep -E "MUST|BACKUP OK|sha256|backup.dump|size|READY lectures|fingerprint|TABLE DATA" || true
step "2. restore the backup into a scratch PG17 database and compare"
ops/neon-migration/restore-verify.sh "$R/backup" "$SCR/postgres" askai_restore_test 2>&1 | grep -E "OK|VERIFIED|MISMATCH"
step "3. apply migrations 006 + 007 (each in ONE transaction) to a copy of the restored data"
$P17 postgres -qc "DROP DATABASE IF EXISTS askai_migrate_test" -c "CREATE DATABASE askai_migrate_test TEMPLATE askai_restore_test" 2>&1 | grep -v NOTICE || true
for f in 006_dataset_versions 007_answer_memory_dataset_version; do $P17 askai_migrate_test -v ON_ERROR_STOP=1 -q --single-transaction -f src/db/migrations/$f.sql 2>&1 | grep -v NOTICE || true; echo "applied $f"; done
step "4. post-migration checks (all must be t)"; $P17 askai_migrate_test -X -At -F ' => ' -f ops/neon-migration/postcheck.sql
step "5. no existing row changed by the migration (fingerprint diff)"
$P17 askai_migrate_test -X -At -F '|' -f ops/neon-migration/snapshot.sql > "$R/snapshot-after-migration.txt"
diff "$R/backup/snapshot-source.txt" "$R/snapshot-after-migration.txt" && echo "IDENTICAL"
step "6. a real dataset update on the migrated copy (lecture 6, one corrected row, real embedding model)"
$P17 postgres -qc "DROP DATABASE IF EXISTS askai_rb_test" -c "CREATE DATABASE askai_rb_test TEMPLATE askai_migrate_test" 2>&1 | grep -v NOTICE || true
DATABASE_URL="$SCR/askai_rb_test" ./node_modules/.bin/ts-node --transpile-only ops/neon-migration/rehearsal-update.ts 2>&1 | grep -E "^update:"
Q="$P17 askai_rb_test -tAc"
echo "lecture 6 chunk rows (all versions) = $($Q "select count(*) from lecture_qna_chunks where lecture_id=6") ; live version members = $($Q "select count(*) from dataset_version_chunks where version_id=(select active_version_id from lectures where id=6)")"
if [ -n "${BASELINE_BACKEND:-}" ]; then
  step "7. ORIGINAL code against the migrated database, before any rollback step"
  for s in test-rag-answer-memory test-agent-readiness; do printf "  legacy %-26s" $s; (cd "$BASELINE_BACKEND" && DATABASE_URL="$SCR/askai_rb_test" ./node_modules/.bin/ts-node --transpile-only src/scripts/$s.ts 2>&1 | grep -E "passed" | tail -1 | cut -c1-80) || true; done
fi
step "8. compensating rollback script (down-to-legacy.sql)"
$P17 askai_rb_test -v ON_ERROR_STOP=1 -q -f ops/neon-migration/down-to-legacy.sql 2>&1 | grep -v NOTICE || true
echo "lecture 6 chunk rows now = $($Q "select count(*) from lecture_qna_chunks where lecture_id=6") ; version tables left = $($Q "select count(*) from information_schema.tables where table_name in ('dataset_versions','dataset_version_chunks')")"
if [ -n "${BASELINE_BACKEND:-}" ]; then
  step "9. ORIGINAL code after the down script"
  for s in test-rag-answer-memory test-agent-readiness test-lecture-agent-profile test-session-isolation; do printf "  legacy %-26s" $s; (cd "$BASELINE_BACKEND" && DATABASE_URL="$SCR/askai_rb_test" ./node_modules/.bin/ts-node --transpile-only src/scripts/$s.ts 2>&1 | grep -E "passed" | tail -1 | cut -c1-80) || true; done
fi
echo; echo "REHEARSAL COMPLETE (log: $R)"
