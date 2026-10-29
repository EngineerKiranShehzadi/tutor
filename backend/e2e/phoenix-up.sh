#!/usr/bin/env bash
# Local Arize Phoenix for the e2e run, on NON-default host ports (UI/OTLP-http 6016, gRPC 4327) so it can never
# collide with a Phoenix you run yourself on 6006. Traces come only from the isolated e2e backend (E2E_PHOENIX=1).
docker rm -f askai-phoenix >/dev/null 2>&1
docker run -d --name askai-phoenix -p 6016:6006 -p 4327:4317 arizephoenix/phoenix:latest
for i in $(seq 1 90); do curl -s -o /dev/null -m 2 http://localhost:6016/ && { echo "Phoenix up: http://localhost:6016"; exit 0; }; sleep 2; done
echo "Phoenix did not come up"; exit 1
