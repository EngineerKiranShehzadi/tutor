import { query } from '../../config/database';
import { env } from '../../config/env';

// Postgres-only reads over rag_request_log / lectures for the admin monitor
// dashboard. Deliberately independent of Phoenix. Never selects question or
// answer text (rag_request_log holds none).

export type MonitorWindow = '24h' | '7d' | '30d';

const WINDOW_INTERVAL: Record<MonitorWindow, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export const parseWindow = (v: unknown): MonitorWindow =>
  v === '7d' || v === '30d' ? v : '24h';

// Same four statuses as the 008 partial index and observability/sampling.ts.
export const ANSWERED_STATUSES = ['ANSWERED', 'MEMORY_HIT_ANSWERED', 'GREETING_ANSWERED', 'SUMMARY_ANSWERED'] as const;
const ANSWERED = `(${ANSWERED_STATUSES.map(s => `'${s}'`).join(', ')})`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// Rates are 0..1; null (not 0) when there were no requests.
export const rate = (count: unknown, total: number): number | null => (total === 0 ? null : Number(count) / total);

export const bucketUnit = (window: MonitorWindow): 'hour' | 'day' => (window === '30d' ? 'day' : 'hour');

export type AttentionReason = 'error' | 'not_answered' | 'verifier' | 'slow';

// Mirrors the WHERE clause of getAttention. Like the SQL, a NULL
// response_status or NULL verification reason never counts as a problem.
export function buildReasons(
  row: { status: string; responseStatus: string | null; answerVerificationReason: string | null; totalMs: number },
  slowMs: number
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (row.status === 'ERROR') reasons.push('error');
  if (row.responseStatus !== null && !(ANSWERED_STATUSES as readonly string[]).includes(row.responseStatus)) reasons.push('not_answered');
  if (row.answerVerificationReason !== null && row.answerVerificationReason !== 'VERIFIED') reasons.push('verifier');
  if (row.totalMs > slowMs) reasons.push('slow');
  return reasons;
}

// ── 1. Summary ───────────────────────────────────────────────────────

export interface PeriodSummary {
  totalRequests: number;
  answeredRate: number | null;
  notFoundRate: number | null;
  guardrailRejectedRate: number | null;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number | null;
  tokens: { input: number; output: number; total: number };
}

async function summarizePeriod(startOffset: string, endOffset: string): Promise<PeriodSummary> {
  // created_at in [now - startOffset, now - endOffset)
  const { rows } = await query<Record<string, unknown>>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE response_status IN ${ANSWERED})::int AS answered,
            count(*) FILTER (WHERE response_status = 'NOT_FOUND')::int AS not_found,
            count(*) FILTER (WHERE response_status = 'GUARDRAIL_REJECTED')::int AS guardrail,
            count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
            (percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_ms))::float8 AS p50,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms))::float8 AS p95,
            sum(est_cost_usd)::float8 AS cost,
            coalesce(sum(input_tokens), 0)::float8 AS in_tokens,
            coalesce(sum(output_tokens), 0)::float8 AS out_tokens
       FROM rag_request_log
      WHERE created_at >= now() - $1::interval
        AND created_at <  now() - $2::interval`,
    [startOffset, endOffset]
  );
  const r = rows[0];
  const total = Number(r.total);
  const input = Number(r.in_tokens);
  const output = Number(r.out_tokens);
  return {
    totalRequests: total,
    answeredRate: rate(r.answered, total),
    notFoundRate: rate(r.not_found, total),
    guardrailRejectedRate: rate(r.guardrail, total),
    errorRate: rate(r.errors, total),
    p50Ms: num(r.p50),
    p95Ms: num(r.p95),
    totalCostUsd: num(r.cost),
    tokens: { input, output, total: input + output },
  };
}

export async function getSummary(window: MonitorWindow): Promise<{ window: MonitorWindow; current: PeriodSummary; previous: PeriodSummary }> {
  const w = WINDOW_INTERVAL[window];
  const doubled = { '24h': '48 hours', '7d': '14 days', '30d': '60 days' }[window];
  const [current, previous] = await Promise.all([
    summarizePeriod(w, '0 seconds'),
    summarizePeriod(doubled, w),
  ]);
  return { window, current, previous };
}

// ── 2. Timeseries ────────────────────────────────────────────────────

export interface TimeseriesBucket {
  bucket: string;
  answered: number;
  notFound: number;
  errors: number;
  p95Ms: number;
}

export async function getTimeseries(window: MonitorWindow): Promise<{ window: MonitorWindow; bucketSize: 'hour' | 'day'; buckets: TimeseriesBucket[] }> {
  const unit = bucketUnit(window);
  // The series starts at the bucket containing (now - window) so every
  // bucket is whole; the data filter uses the same lower bound.
  const { rows } = await query<Record<string, unknown>>(
    `WITH series AS (
       SELECT generate_series(
                date_trunc($1, now() - $2::interval),
                date_trunc($1, now()),
                ('1 ' || $1)::interval
              ) AS bucket
     ), agg AS (
       SELECT date_trunc($1, created_at) AS bucket,
              count(*) FILTER (WHERE response_status IN ${ANSWERED})::int AS answered,
              count(*) FILTER (WHERE response_status = 'NOT_FOUND')::int AS not_found,
              count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
              (percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms))::float8 AS p95
         FROM rag_request_log
        WHERE created_at >= date_trunc($1, now() - $2::interval)
        GROUP BY 1
     )
     SELECT to_char(s.bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
            coalesce(a.answered, 0) AS answered,
            coalesce(a.not_found, 0) AS not_found,
            coalesce(a.errors, 0) AS errors,
            coalesce(a.p95, 0) AS p95
       FROM series s LEFT JOIN agg a ON a.bucket = s.bucket
      ORDER BY s.bucket`,
    [unit, WINDOW_INTERVAL[window]]
  );
  return {
    window,
    bucketSize: unit,
    buckets: rows.map(r => ({
      bucket: String(r.bucket),
      answered: Number(r.answered),
      notFound: Number(r.not_found),
      errors: Number(r.errors),
      p95Ms: Number(r.p95),
    })),
  };
}

// ── 3. Attention ─────────────────────────────────────────────────────

export interface AttentionRow {
  traceId: string;
  createdAt: string;
  lectureId: number | null;
  lectureTitle: string | null;
  route: string | null;
  responseStatus: string | null;
  notFoundReason: string | null;
  errorCode: string | null;
  answerVerificationReason: string | null;
  totalMs: number;
  exportedToPhoenix: boolean;
  reasons: AttentionReason[];
}

export async function getAttention(limit: number, before: string | null): Promise<{ rows: AttentionRow[]; nextBefore: string | null }> {
  // createdAt is rendered with microseconds so that passing it back as
  // `before` neither skips nor repeats rows (JS Dates stop at milliseconds).
  const { rows } = await query<Record<string, unknown>>(
    `SELECT r.trace_id, r.id, r.status,
            to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            r.lecture_id, l.title AS lecture_title, r.route, r.response_status,
            r.not_found_reason, r.error_code, r.answer_verification_reason,
            r.total_ms, r.exported_to_phoenix
       FROM rag_request_log r
       LEFT JOIN lectures l ON l.id = r.lecture_id
      WHERE (r.status = 'ERROR'
             OR r.response_status NOT IN ${ANSWERED}
             OR r.answer_verification_reason <> 'VERIFIED'
             OR r.total_ms > $1)
        AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $3`,
    [env.OBSERVABILITY.SLOW_TRACE_MS, before, limit]
  );
  const slowMs = env.OBSERVABILITY.SLOW_TRACE_MS;
  const mapped: AttentionRow[] = rows.map(r => ({
    traceId: String(r.trace_id).trim(),
    createdAt: String(r.created_at),
    lectureId: num(r.lecture_id),
    lectureTitle: (r.lecture_title as string | null) ?? null,
    route: (r.route as string | null) ?? null,
    responseStatus: (r.response_status as string | null) ?? null,
    notFoundReason: (r.not_found_reason as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    answerVerificationReason: (r.answer_verification_reason as string | null) ?? null,
    totalMs: Number(r.total_ms),
    exportedToPhoenix: Boolean(r.exported_to_phoenix),
    reasons: buildReasons({
      status: String(r.status),
      responseStatus: (r.response_status as string | null) ?? null,
      answerVerificationReason: (r.answer_verification_reason as string | null) ?? null,
      totalMs: Number(r.total_ms),
    }, slowMs),
  }));
  return { rows: mapped, nextBefore: mapped.length === limit ? mapped[mapped.length - 1].createdAt : null };
}

// ── 4. Lectures ──────────────────────────────────────────────────────

export interface LectureStats {
  lectureId: number;
  title: string;
  requests: number;
  answeredRate: number | null;
  notFoundRate: number | null;
  p50Ms: number | null;
}

export async function getLectureStats(window: MonitorWindow): Promise<LectureStats[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT l.id AS lecture_id, l.title,
            count(*)::int AS requests,
            count(*) FILTER (WHERE r.response_status IN ${ANSWERED})::int AS answered,
            count(*) FILTER (WHERE r.response_status = 'NOT_FOUND')::int AS not_found,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.total_ms))::float8 AS p50
       FROM rag_request_log r
       JOIN lectures l ON l.id = r.lecture_id
      WHERE r.created_at >= now() - $1::interval
      GROUP BY l.id, l.title`,
    [WINDOW_INTERVAL[window]]
  );
  return rows
    .map(r => {
      const requests = Number(r.requests);
      return {
        lectureId: Number(r.lecture_id),
        title: String(r.title),
        requests,
        answeredRate: rate(r.answered, requests),
        notFoundRate: rate(r.not_found, requests),
        p50Ms: num(r.p50),
      };
    })
    .sort((a, b) => (b.notFoundRate ?? 0) - (a.notFoundRate ?? 0) || b.requests - a.requests);
}

// ── 5. Stages ────────────────────────────────────────────────────────

export interface StageStats { stage: string; p50Ms: number; p95Ms: number; count: number }

export async function getStageStats(window: MonitorWindow): Promise<StageStats[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT s.key AS stage,
            (percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.value::float8))::float8 AS p50,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY s.value::float8))::float8 AS p95,
            count(*)::int AS count
       FROM rag_request_log r
      CROSS JOIN LATERAL jsonb_each_text(r.stage_ms) AS s(key, value)
      WHERE r.created_at >= now() - $1::interval
        AND jsonb_typeof(r.stage_ms) = 'object'
      GROUP BY s.key
      ORDER BY p95 DESC`,
    [WINDOW_INTERVAL[window]]
  );
  return rows.map(r => ({ stage: String(r.stage), p50Ms: Number(r.p50), p95Ms: Number(r.p95), count: Number(r.count) }));
}
