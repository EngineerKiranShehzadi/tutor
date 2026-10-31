#!/usr/bin/env bash
# Brings up the isolated e2e stack: fresh local DB -> embed proxy -> backend (LLM stubbed) -> frontend.
# Needs: docker pgvector container "askai-test-pg" on :55432 (see README), the real embedding server on :5001.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"; OUT="${E2E_OUT:-/tmp/askai-e2e}"; mkdir -p "$OUT/shots" "$OUT/logs"
export PGPASSWORD=test
PSQL="psql -h localhost -p 55432 -U postgres"
$PSQL postgres -qc "DROP DATABASE IF EXISTS askai_e2e_test" -c "CREATE DATABASE askai_e2e_test" 2>&1 | grep -v NOTICE || true
export DATABASE_URL=postgresql://postgres:test@localhost:55432/askai_e2e_test
npm run -s db:setup > "$OUT/logs/db-setup.log" 2>&1
./node_modules/.bin/ts-node --transpile-only e2e/seed.ts 2>/dev/null | grep lectureId > "$OUT/ctx.json"
echo 0 > "$OUT/llm_delay"
node e2e/embed-proxy.js 5101 > "$OUT/logs/proxy.log" 2>&1 & echo $! > "$OUT/proxy.pid"
# E2E_LLM=real -> no stub: every LLM service calls the configured provider (OPENAI_API_KEY from backend/.env; spends tokens).
# E2E_PHOENIX=1 -> export this backend's traces to the e2e Phoenix (e2e/phoenix-up.sh, :6016); prompt/answer content captured (test data only).
if [ "${E2E_PHOENIX:-0}" = "1" ]; then
  export OBSERVABILITY_ENABLED=true PHOENIX_ENABLED=true PHOENIX_ENDPOINT=http://localhost:6016/v1/traces PHOENIX_BASE_URL=http://localhost:6016 \
         PHOENIX_PROJECT_NAME="${PHOENIX_PROJECT_NAME:-askaitutor-e2e}" OBSERVABILITY_CAPTURE_CONTENT=true
fi
PORT=5055 FRONTEND_URL=http://localhost:3055 EMBEDDING_SERVER_URL=http://localhost:5101/embed DATASET_RETRY_DELAY_MS=3000 \
  E2E_LLM_DELAY_FILE="$OUT/llm_delay" ./node_modules/.bin/ts-node --transpile-only src/scripts/e2e-server.ts > "$OUT/logs/backend.log" 2>&1 & echo $! > "$OUT/backend.pid"
( cd ../frontend && NEXT_PUBLIC_API_URL=http://localhost:5055/api/v1 ./node_modules/.bin/next dev -p 3055 > "$OUT/logs/frontend.log" 2>&1 & echo $! > "$OUT/frontend.pid" )
for i in $(seq 1 90); do
  curl -s -o /dev/null localhost:5055/api/v1/health 2>/dev/null; B=$(ss -ltn | grep -c ':5055 ' || true); F=$(ss -ltn | grep -c ':3055 ' || true)
  [ "$B" -ge 1 ] && [ "$F" -ge 1 ] && break; sleep 1
done
echo "stack up: backend :5055 (stub LLM), frontend :3055, embed proxy :5101 -> real :5001; ctx at $OUT/ctx.json"
