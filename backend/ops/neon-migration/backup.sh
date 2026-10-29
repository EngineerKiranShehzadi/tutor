#!/usr/bin/env bash
# Read-only on the source. Usage: backup.sh <SOURCE_DATABASE_URL> <OUT_DIR>
# pg_dump runs from a postgres:17 image because the source is PostgreSQL 17 (a local pg_dump 16 refuses it).
set -euo pipefail
SRC="$1"; OUT="$(mkdir -p "$2" && cd "$2" && pwd)"
PG17="pgvector/pgvector:pg17"
cd "$(dirname "$0")"
echo "== 1/4 pre-flight (read-only)"; docker run --rm --network host -v "$PWD":/ops:ro "$PG17" psql "$SRC" -X -f /ops/preflight.sql | tee "$OUT/preflight.txt"
echo "== 2/4 fingerprint of the source"; docker run --rm --network host -v "$PWD":/ops:ro "$PG17" psql "$SRC" -X -At -F '|' -f /ops/snapshot.sql | tee "$OUT/snapshot-source.txt"
echo "== 3/4 logical backup (custom format, whole database)"
docker run --rm --network host -v "$OUT":/out "$PG17" pg_dump "$SRC" --format=custom --no-owner --no-privileges --file=/out/backup.dump
( cd "$OUT" && sha256sum backup.dump | tee backup.dump.sha256 && ls -l backup.dump | awk '{print "size bytes:", $5}' )
echo "== 4/4 dump is readable"; docker run --rm -v "$OUT":/out "$PG17" pg_restore --list /out/backup.dump | grep -cE 'TABLE DATA' | xargs echo "TABLE DATA entries in dump:"
echo "BACKUP OK -> $OUT   (also take a Neon branch / point-in-time marker in the console — see RUNBOOK.md)"
