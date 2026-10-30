# Observability runbook

## Architecture

Three channels, each with one job. **Phoenix** (self-hosted, `deploy/observability/`) holds traces and is for debugging one request. **`rag_request_log`** (a Postgres table in the app database, one row per request, metadata only) is the source of the numbers: the AI Tutor Monitor dashboard, `/monitor/attention` and the email alerts. **Logs** are JSON on stdout and carry a `traceId` that matches the trace in Phoenix and the `rag_request_log` row. Everything is optional and fail-open: the student request path never depends on Phoenix, and if Phoenix is down only trace deep links and exports are lost, not the dashboard or alerts.

```
                      +--> Phoenix (traces, OTLP)  <-----------------+
                      |                                              |
 student --> backend -+--> rag_request_log (Postgres, 1 row/request)  | "Open in Phoenix"
                      |        ^                                     | (deep link built from
                      |        | trace_id (CHAR 32)                  |  trace_id + PHOENIX_PUBLIC_URL)
                      |        v                                     |
                      |    chat_history.trace_id                     |
                      |                                              |
                      +--> stdout logs (JSON, each line has traceId) |
                                   ^                                 |
 admin --> /admin/monitor --reads--+--> rag_request_log -------------+
```

The same 32-character `trace_id` is stored in `rag_request_log` and `chat_history.trace_id`, is the trace id in Phoenix, and is the `traceId` field in the logs, so any one of them leads to the other three.

## First-time setup

Do these in order.

1. **Create the Phoenix database.** In Neon create a *separate* database (or project) only for Phoenix, e.g. `phoenix`, with its own role. Never reuse the app database. Use the **direct** (non-pooler) host. Connection string shape: `postgresql://phoenix_user:PASSWORD@ep-xxxx.region.aws.neon.tech/phoenix?sslmode=require`.
2. **Apply migration 008 on Neon** (before anything else touches the backend), using the **direct** connection, after a backup per `backend/ops/neon-migration/RUNBOOK.md` (section 2):
   ```
   psql "$NEON_DIRECT_URL" -v ON_ERROR_STOP=1 --single-transaction -f backend/src/db/migrations/008_rag_request_log.sql
   ```
   Never run `npm run db:setup` against production.
3. **Start the container** on the server that runs the backend:
   ```
   cd deploy/observability
   cp .env.example .env        # fill in all three values (see comments in the file)
   docker compose up -d
   docker compose ps           # wait for "healthy" (up to ~1 min)
   ```
   `.env` is git-ignored. Compose refuses to start if a required value is missing.
4. **Log in and change the admin password.** Open Phoenix (see "Reaching Phoenix securely"), log in as `admin@localhost` with `PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD`, and change the password under your profile.
5. **Create a System API key**: Settings -> API Keys -> *System* -> create. Copy it now; it is shown once.
6. **Configure the backend** (`backend/.env` or the host's secret store):
   ```
   OBSERVABILITY_ENABLED=true
   PHOENIX_ENABLED=true
   PHOENIX_OTLP_ENDPOINT=http://127.0.0.1:6006/v1/traces
   PHOENIX_BASE_URL=http://127.0.0.1:6006
   PHOENIX_PUBLIC_URL=https://phoenix.example.com     # what an admin opens in a browser; empty = no deep links
   PHOENIX_API_KEY=<the system key>
   ```
   `PHOENIX_OTLP_ENDPOINT` must include `/v1/traces`; `PHOENIX_BASE_URL` must not. If the backend runs on a different host than Phoenix, `127.0.0.1` will not work: put both on a private network/VPN and publish Phoenix on that interface's address in `docker-compose.yml` (still never `0.0.0.0`).
7. **Restart the backend.** Look for `[PHOENIX] Exporter initialized -> ...` in its log.
8. **Verify a trace arrives.** Ask the tutor one question. In Phoenix open project `PHOENIX_PROJECT_NAME` and confirm the trace is there. Note: only a `OBSERVABILITY_SAMPLE_RATE` fraction of ordinary fast answers is exported; errors, non-answered, verifier failures and slow requests are always exported, so for the first check keep the rate at `1` or ask several questions. A 401 from Phoenix in the backend log means a wrong or missing `PHOENIX_API_KEY`.

## Reaching Phoenix securely

Phoenix is bound to `127.0.0.1` on the server. Never open port 6006 publicly. Pick one:

- **SSH tunnel** (simplest): `ssh -L 6006:127.0.0.1:6006 user@server`, then browse to `http://localhost:6006`. `PHOENIX_USE_SECURE_COOKIES=True` normally still works on `localhost` in Chrome and Firefox; if login silently fails in your browser, use a reverse proxy with HTTPS instead.
- **VPN** (WireGuard/Tailscale): join the server to the VPN and browse to its VPN address. Publish the container port on the VPN interface address only, not `0.0.0.0`, and use HTTPS or accept that secure cookies need it.
- **Reverse proxy with HTTPS** (Caddy/nginx) on the same host, proxying to `127.0.0.1:6006`, with a valid certificate, ideally plus an IP allow-list or SSO in front. Set `PHOENIX_PUBLIC_URL` to this HTTPS URL. Phoenix's own login is still required behind it.

## External uptime monitor

Use a free service (UptimeRobot, Better Stack, Healthchecks.io). Create an HTTPS monitor on `https://<your-api-host>/health/ready`, interval 5 min, alert by email/phone. `/health/ready` returns HTTP 200 for `healthy` and `degraded` (reranker or Gemini down) and **503** for `unhealthy` (database, pgvector or embedding server down), so a plain status-code check is enough. Use `/health/live` if you only want to know the process is up. This is separate from the in-app email alerts, which cannot fire if the whole backend is down.

## Environment variables

Backend variables (defaults as in `backend/src/config/env.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `OBSERVABILITY_ENABLED` | `false` | Master switch for tracing/export |
| `PHOENIX_ENABLED` | `false` | Enables the Phoenix exporter (needs both flags true) |
| `OBSERVABILITY_SAMPLE_RATE` | `1` | Fraction of ordinary fast answered traces exported; interesting ones always are |
| `OBSERVABILITY_SLOW_TRACE_MS` | `10000` | Traces slower than this are always exported |
| `OBSERVABILITY_CAPTURE_CONTENT` | `false` | Capture question/answer/prompt previews on spans; false = metadata only |
| `OBSERVABILITY_MAX_CONTENT_LENGTH` | `20000` | Max characters per captured content field |
| `OBSERVABILITY_RETENTION_DAYS` | `90` | `rag_request_log` rows older than this are deleted daily |
| `REQUEST_LOG_ENABLED` | `true` | Write one `rag_request_log` row per request |
| `LLM_PRICING_JSON` | empty | Per-model USD prices for cost estimate; unknown model -> NULL cost |
| `PHOENIX_OTLP_ENDPOINT` | empty | OTLP/HTTP ingest URL, ending `/v1/traces` |
| `PHOENIX_ENDPOINT` | empty | Back-compat alias of the above |
| `PHOENIX_BASE_URL` | `http://localhost:6006` | Phoenix root URL for backend read-back calls |
| `PHOENIX_PUBLIC_URL` | empty | Browser URL for admin deep links; empty = no links |
| `PHOENIX_API_KEY` | empty | System API key, sent as Bearer token; server-side only |
| `PHOENIX_PROJECT_NAME` | `askaitutor-rag` | Phoenix project traces land in |
| `PHOENIX_QUERY_TIMEOUT_MS` | `10000` | Timeout for backend -> Phoenix queries |
| `PHOENIX_OVERVIEW_CACHE_TTL_MS` | `15000` | Cache TTL for Phoenix overview data |
| `OBSERVABILITY_ALERTS_ENABLED` | `false` | Enables email alerts |
| `ALERT_CHECK_INTERVAL_MS` | `300000` | How often rules run |
| `ALERT_WINDOW_MINUTES` | `15` | Look-back window for rules |
| `ALERT_MIN_REQUESTS` | `20` | Minimum requests in window before rate rules apply |
| `ALERT_ERROR_RATE` | `0.05` | Error-rate threshold (0..1) |
| `ALERT_NOT_FOUND_RATE` | `0.40` | Not-found-rate threshold (0..1) |
| `ALERT_P95_MS` | `15000` | p95 latency threshold |
| `ALERT_COOLDOWN_MINUTES` | `60` | Minimum gap between repeats of the same alert |
| `ALERT_CONSECUTIVE_HEALTH_FAILURES` | `3` | (not used yet) read into config but no code uses it; there is no health alert rule |
| `ALERT_EMAILS` | empty | Recipients, comma-separated; empty = all ADMIN users |
| `HEALTH_CHECK_CACHE_TTL_MS` | `60000` | Cache TTL for component health checks |
| `HEALTH_GEMINI_CHECK_ENABLED` | `true` | Include Gemini in readiness |
| `LOG_TO_FILE` | `false` | Also write logs to files (production only). Keep `false` in production: the platform collects stdout |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful-shutdown deadline; the process forces exit 1 if shutdown takes longer |

Phoenix container variables (`deploy/observability/.env`): `PHOENIX_SQL_DATABASE_URL`, `PHOENIX_SECRET`, `PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD` (no defaults; required). The compose file fixes `PHOENIX_ENABLE_AUTH=True`, `PHOENIX_USE_SECURE_COOKIES=True`, `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS=30`.

## Production settings

- **`OBSERVABILITY_ALERTS_ENABLED=true` must be set explicitly.** The default is `false`; without it no alert email is ever sent.
- **`DATABASE_URL` must be the Neon DIRECT (non-pooler) connection.** Alerts and the nightly cleanup use `pg_try_advisory_lock`, which is session-scoped and unreliable through a transaction pooler (the lock can be taken and released on different connections, so two instances may both run, or a lock may leak).
- **Migration 008 must be applied first** (setup step 2: backup per `backend/ops/neon-migration/RUNBOOK.md`, then psql on the direct connection). Deploy order: database, backend, frontend.
- **Set `OBSERVABILITY_SAMPLE_RATE`**, e.g. `0.2`. Errors, non-answered, verifier failures and slow requests are still always exported; `rag_request_log` still records every request.
- **Fill `LLM_PRICING_JSON` with real prices** from the provider's pricing page, e.g. `{"gemini-2.5-flash":{"inputPer1M":<usd>,"outputPer1M":<usd>}}`. Left empty, every cost is NULL.
- Keep `OBSERVABILITY_CAPTURE_CONTENT=false` unless you have decided that student questions and answers may be stored in Phoenix.

## Known gaps

- Provider error messages are logged via `err.message`, and some providers echo fragments of the request (prompt text or student question) inside the error. Those fragments can therefore appear in stdout logs. Restrict log access accordingly until messages are scrubbed.
- **FIX-1: a database outage returns 401 and logs every user out.** Fix pending (tracked as FIX-1 in the team's observability plan; not yet in this repo). Before treating a burst of 401s as an auth bug, check `/health/ready`.
- The admin sidebar is not mobile-friendly.
- **Upgrading Phoenix.** The compose file pins `version-20.27.0`, the version tested with the backend, which uses `@arizeai/phoenix-client` 7.1.1. Before moving to a new major (e.g. 21.x), test it locally against a copy of the setup (login, System API key, a trace arriving, the admin deep links and overview queries) and only then change the tag.

## What to do when

**Alert email received.** There are exactly four rules: `error_rate`, `not_found_rate`, `p95_latency` and `llm_rate_limited`; the email names the one that fired and its value (there is no health rule). Open the AI Tutor Monitor, then `/monitor/attention`. Note that `/monitor/attention` shows the *most recent problems*, not only those inside the alert window, so match rows to the alert by timestamp. Use the lecture column and the route to see whether the problem is one lecture or one endpoint, open the row's Phoenix link (`PHOENIX_PUBLIC_URL`) or grep logs for its `traceId`, and check `/health/ready` for a down dependency (database, embedding server, reranker, Gemini). Repeats are throttled by `ALERT_COOLDOWN_MINUTES`. If it is a false alarm, tune thresholds rather than disabling alerts.

**Gemini rate-limit alerts (`llm_rate_limited`).** The Gemini free tier allows 20 requests per day per model (this figure comes from the provider's 429 error message), so this is the rule most likely to fire on a free key. Unlike the other rules it ignores `ALERT_MIN_REQUESTS`: a single rate-limited request in the window is enough. Options: wait for the daily quota reset; switch the affected service to another LLM provider through its `*_PROVIDER` / model env vars (see `backend/.env.example`); or upgrade the Gemini plan.

**Phoenix down.** Students are not affected: export is fire-and-forget and the dashboard and alerts run off `rag_request_log`. Traces during the outage are lost (not buffered). Check `docker compose ps` and `docker compose logs --tail 100 phoenix` in `deploy/observability`. Common causes: wrong or unreachable `PHOENIX_SQL_DATABASE_URL` (Neon project suspended, bad credentials), or the Neon storage limit being reached (the free plan caps project storage; Phoenix traces count against it: lower retention or the sample rate, or move Phoenix to its own Neon project). `docker compose up -d` restarts it; `restart: unless-stopped` already restarts after crashes and reboots. After recovery, send a question and confirm a trace appears. A 401 in backend logs after a restore means the API key was revoked or `PHOENIX_SECRET` changed: create a new System key and update `PHOENIX_API_KEY`.

**`rag_request_log` growing fast.** Check size: `SELECT pg_size_pretty(pg_total_relation_size('rag_request_log')), count(*) FROM rag_request_log;`. Confirm the nightly cleanup is running (backend log; needs the direct connection, see above) and lower `OBSERVABILITY_RETENTION_DAYS` (default 90). Rows are metadata-only and small, so fast growth normally means high traffic or a retry loop: check the lecture column and route in `/monitor/attention` and the Monitor dashboard to see which lecture or endpoint is generating the volume. Do not turn off `REQUEST_LOG_ENABLED` as a first response; the dashboard and alerts depend on it. Phoenix size is separate and capped by its 30-day retention; lower `OBSERVABILITY_SAMPLE_RATE` to reduce it.

## Local development

- **Start Phoenix locally:** `backend/e2e/phoenix-up.sh` runs a throwaway Phoenix container (`askai-phoenix`) with the UI and OTLP/HTTP on port **6016** (gRPC on 4327), deliberately not 6006 so it cannot clash with another Phoenix. Local Phoenix has no auth, so leave `PHOENIX_API_KEY` empty and point `PHOENIX_OTLP_ENDPOINT` at `http://localhost:6016/v1/traces` and `PHOENIX_BASE_URL` at `http://localhost:6016`. It uses the `latest` image, not the version pinned for production. **Warning:** the script first runs `docker rm -f askai-phoenix`, so any existing local Phoenix container and its traces are deleted.
- **Run the observability tests** with the direct runner (it avoids repeated npm startup): from `backend/`, `npx ts-node --transpile-only src/scripts/run-tests.ts`. `npm test` runs the same runner.
- **Seed demo data:** `npm run seed:request-log` inserts about 500 fake `rag_request_log` rows over the last 30 days so the dashboard has something to show. It refuses to run if `NODE_ENV=production` or the database URL is not localhost/127.0.0.1.
- **Clear demo data:** there is no separate clear script yet. Re-running the seed first deletes the previous seed rows, and you can remove them by hand with `DELETE FROM rag_request_log WHERE schema_version = 'seed';`.
