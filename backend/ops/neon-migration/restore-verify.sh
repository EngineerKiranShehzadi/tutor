#!/usr/bin/env bash
# Proves a backup is restorable: restores it into a SCRATCH database (never the source) and compares fingerprints.
# Usage: restore-verify.sh <OUT_DIR from backup.sh> <SCRATCH_ADMIN_URL e.g. postgresql://postgres:test@localhost:55433/postgres> <scratch_db_name>
set -euo pipefail
OUT="$(cd "$1" && pwd)"; ADMIN="$2"; DB="$3"; PG17="pgvector/pgvector:pg17"
BASE="${ADMIN%/*}"
cd "$(dirname "$0")"
( cd "$OUT" && sha256sum -c backup.dump.sha256 )
docker run --rm --network host "$PG17" psql "$ADMIN" -X -qc "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
docker run --rm --network host "$PG17" psql "$BASE/$DB" -X -qc "CREATE EXTENSION IF NOT EXISTS vector"
docker run --rm --network host -v "$OUT":/out "$PG17" pg_restore --no-owner --no-privileges --exit-on-error -d "$BASE/$DB" /out/backup.dump 2>&1 | grep -v "already exists" || true
docker run --rm --network host -v "$PWD":/ops:ro "$PG17" psql "$BASE/$DB" -X -At -F '|' -f /ops/snapshot.sql > "$OUT/snapshot-restored.txt"
if diff -u "$OUT/snapshot-source.txt" "$OUT/snapshot-restored.txt"; then echo "RESTORE VERIFIED: every table count + content fingerprint identical to the source"; else echo "RESTORE MISMATCH"; exit 1; fi
