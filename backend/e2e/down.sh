#!/usr/bin/env bash
OUT="${E2E_OUT:-/tmp/askai-e2e}"
for n in frontend backend proxy; do [ -f "$OUT/$n.pid" ] && kill "$(cat "$OUT/$n.pid")" 2>/dev/null; done
for p in 3055 5055 5101; do ss -ltnp 2>/dev/null | grep ":$p " | sed -E 's/.*pid=([0-9]+).*/\1/' | xargs -r kill 2>/dev/null; done
echo "e2e stack stopped"
