import { getSpans } from '@arizeai/phoenix-client/spans';
import { query } from '../../config/database';
import { env } from '../../config/env';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import {
  mapPhoenixSpan, extractTraceSummary, buildSpanTree, buildTimeline, buildCriticalPath, depthMapFromTree,
  type RawPhoenixSpan,
} from './normalize';
import { getTraceAnnotationsFor, getTraceNotesFor } from './annotations.service';
import { sanitizeValue } from '../../observability/sanitize';
import { buildPhoenixTraceUrl } from './phoenix-links';
import type { TraceSummary, TraceDetail } from './types';

export interface TraceListFilters {
  cursor?: string | null;
  limit?: number;
  startTime?: string;
  endTime?: string;
  search?: string;
  traceId?: string;
  sessionId?: string;
  lectureId?: string;
  userId?: string;
  route?: string;
  status?: string;
  spanKind?: string;
  spanName?: string;
  model?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  memoryResult?: string;
  errorOnly?: boolean;
  errorCode?: string;
  sort?: 'start_time' | 'latency_ms';
  order?: 'asc' | 'desc';
}

export interface TraceListResult {
  traces: TraceSummary[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
  // Phoenix fallback only (request log off): traces read from Phoenix to build
  // this page, which can exceed traces.length; scanLimitReached says the search
  // stopped at FILTER_SCAN_LIMIT, so an empty page means "none in the traces
  // checked", not "none at all". From the request log every filter covers the
  // whole history, so scannedTraces is the page size and the limit is never hit.
  scannedTraces: number;
  scanLimitReached: boolean;
}

// ── The list comes from rag_request_log ─────────────────────────────────
// Phoenix's trace list returns each span as id, name, kind, status and times
// only, with no attributes, so route, lecture, student, model, memory result
// and error code are unknown there: a filter on any of them matched nothing,
// and the list showed them blank. rag_request_log (migration 008) has every
// one of them for every request. Only requests exported to Phoenix are
// listed, so each row opens in the trace view, which still reads its spans
// from Phoenix. Filters, sort and paging all run in SQL over the whole log.

interface LogListRow {
  id: string;
  trace_id: string;
  created_at: Date;
  student_id: string | null;
  lecture_id: number | null;
  session_id: number | null;
  route: string | null;
  status: string;
  error_code: string | null;
  memory_result: string | null;
  not_found_reason: string | null;
  total_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  llm_model: string | null;
  schema_version: string | null;
  sort_key: string;
}

// The Traces page's "Miss" means the lookup missed; the log then records what
// happened to the new answer (ENTRY_CREATED / WRITE_FAILED) instead of MISS.
const MEMORY_RESULT_MATCHES: Record<string, string[]> = { MISS: ['MISS', 'ENTRY_CREATED', 'WRITE_FAILED'] };
// The log records SUCCESS / ERROR; Phoenix's own spelling of success is OK.
const STATUS_MATCHES: Record<string, string> = { SUCCESS: 'SUCCESS', OK: 'SUCCESS', ERROR: 'ERROR' };
const SORT_COLUMNS = {
  start_time: { column: 'created_at', type: 'timestamptz' },
  latency_ms: { column: 'total_ms', type: 'int' },
} as const;
const INT_ID = /^\d{1,9}$/;

const encodeCursor = (sortKey: string, id: string): string => Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && /^\d+$/.test(v[1])) return [v[0], v[1]];
  } catch { /* falls through */ }
  throw new ObservabilityError('INVALID_OBSERVABILITY_FILTER', 'Invalid trace list cursor — reload the list');
}

// PURE: the SQL and parameters for one page (limit + 1 rows, the extra one
// only says whether there is a next page).
export function buildTraceListQuery(filters: TraceListFilters, limit: number): { sql: string; params: unknown[] } {
  const where: string[] = ['exported_to_phoenix'];
  const params: unknown[] = [];
  const param = (value: unknown): string => { params.push(value); return `$${params.length}`; };

  if (filters.startTime) where.push(`created_at >= ${param(filters.startTime)}::timestamptz`);
  if (filters.endTime) where.push(`created_at <= ${param(filters.endTime)}::timestamptz`);
  if (filters.traceId) where.push(`trace_id::text = ${param(filters.traceId.trim().toLowerCase())}`);
  if (filters.search) where.push(`strpos(trace_id::text, ${param(filters.search.trim().toLowerCase())}) > 0`);
  if (filters.userId) where.push(`student_id::text = ${param(filters.userId.trim().toLowerCase())}`);
  if (filters.lectureId) where.push(INT_ID.test(filters.lectureId) ? `lecture_id = ${param(Number(filters.lectureId))}` : 'FALSE');
  if (filters.sessionId) where.push(INT_ID.test(filters.sessionId) ? `session_id = ${param(Number(filters.sessionId))}` : 'FALSE');
  if (filters.route) where.push(`route = ${param(filters.route)}`);
  if (filters.model) where.push(`llm_model = ${param(filters.model)}`);
  if (filters.errorCode) where.push(`error_code = ${param(filters.errorCode)}`);
  if (filters.memoryResult) where.push(`memory_result = ANY(${param(MEMORY_RESULT_MATCHES[filters.memoryResult] ?? [filters.memoryResult])}::text[])`);
  if (filters.status) {
    const status = STATUS_MATCHES[filters.status.toUpperCase()];
    where.push(status ? `status = ${param(status)}` : 'FALSE');
  }
  if (filters.errorOnly) where.push(`status = 'ERROR'`);
  if (filters.minLatencyMs !== undefined) where.push(`total_ms >= ${param(filters.minLatencyMs)}`);
  if (filters.maxLatencyMs !== undefined) where.push(`total_ms <= ${param(filters.maxLatencyMs)}`);

  const { column, type } = SORT_COLUMNS[filters.sort ?? 'start_time'];
  const dir = filters.order === 'asc' ? 'ASC' : 'DESC';
  if (filters.cursor) {
    const [sortKey, id] = decodeCursor(filters.cursor);
    where.push(`(${column}, id) ${dir === 'ASC' ? '>' : '<'} (${param(sortKey)}::${type}, ${param(id)}::bigint)`);
  }

  const sql = `SELECT id::text, trace_id, created_at, student_id::text, lecture_id, session_id, route, status, error_code,
            memory_result, not_found_reason, total_ms, input_tokens, output_tokens, llm_model, schema_version,
            ${column}::text AS sort_key
       FROM rag_request_log
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${column} ${dir}, id ${dir}
      LIMIT ${param(limit + 1)}`;
  return { sql, params };
}

// PURE. The row is written when the request finishes, so it started total_ms
// before created_at. Fields only Phoenix has (question/answer text, span
// counts, routing method) stay empty here; the trace view shows them.
export function summaryFromLogRow(r: LogListRow): TraceSummary {
  const traceId = r.trace_id.trim();
  const totalMs = Number(r.total_ms);
  const tokens = r.input_tokens !== null || r.output_tokens !== null ? (r.input_tokens ?? 0) + (r.output_tokens ?? 0) : null;
  return {
    traceId,
    rootSpanId: null,
    requestId: traceId,
    timestamp: new Date(new Date(r.created_at).getTime() - totalMs).toISOString(),
    durationMs: totalMs,
    status: r.status,
    statusMessage: null,
    route: r.route,
    routingMethod: null,
    questionPreview: null,
    answerPreview: null,
    lectureId: r.lecture_id === null ? null : String(r.lecture_id),
    sessionId: r.session_id === null ? null : String(r.session_id),
    userId: r.student_id,
    memoryResult: r.memory_result,
    retrievalCount: null,
    selectedChunkCount: null,
    model: r.llm_model,
    promptTokens: r.input_tokens,
    completionTokens: r.output_tokens,
    totalTokens: tokens,
    spanCount: 0,
    errorCode: r.error_code,
    fallbackReason: r.not_found_reason,
    environment: null,
    schemaVersion: r.schema_version,
  };
}

async function listTracesFromRequestLog(filters: TraceListFilters, limit: number): Promise<TraceListResult> {
  const { sql, params } = buildTraceListQuery(filters, limit);
  const { rows } = await query<LogListRow>(sql, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    traces: page.map(summaryFromLogRow),
    nextCursor: rows.length > limit && last ? encodeCursor(last.sort_key, last.id) : null,
    appliedFilters: filters as Record<string, unknown>,
    scannedTraces: page.length,
    scanLimitReached: false,
  };
}

// ── Fallback: Phoenix's own list, when the request log is switched off ──
// How many traces one filtered request reads at most — the same window the
// overview's counts (e.g. "Total errors") are computed over.
export const FILTER_SCAN_LIMIT = 500;

// Phoenix's list can answer only what its spans carry: trace id, session,
// root-span status and duration. Everything else needs the request log, and
// is refused rather than silently matching nothing.
const NEEDS_REQUEST_LOG: (keyof TraceListFilters)[] = ['lectureId', 'userId', 'route', 'model', 'memoryResult', 'errorCode'];

const hasPageFilters = (f: TraceListFilters): boolean =>
  !!(f.traceId || f.status || f.errorOnly || f.search)
  || f.minLatencyMs !== undefined || f.maxLatencyMs !== undefined;

function applyPageFilters(traces: TraceSummary[], f: TraceListFilters): TraceSummary[] {
  return traces.filter(t => {
    if (f.traceId && t.traceId !== f.traceId) return false;
    if (f.status && STATUS_MATCHES[t.status.toUpperCase()] !== STATUS_MATCHES[f.status.toUpperCase()]) return false;
    if (f.errorOnly && t.status !== 'ERROR') return false;
    if (f.minLatencyMs !== undefined && t.durationMs < f.minLatencyMs) return false;
    if (f.maxLatencyMs !== undefined && t.durationMs > f.maxLatencyMs) return false;
    if (f.search && !t.traceId.toLowerCase().includes(f.search.toLowerCase())) return false;
    return true;
  });
}

interface PhoenixTracePage {
  traces: {
    trace_id: string; start_time: string; end_time: string; spans?: unknown[] | null;
    token_count_prompt?: number; token_count_completion?: number; token_count_total?: number;
  }[];
  nextCursor: string | null;
}

// The same request @arizeai/phoenix-client's getTraces sends, plus `error=true`
// for an errors-only list: Phoenix then returns only traces with an errored
// span (a superset of ERROR-status traces), so the in-memory check below
// rarely has to read past the first page. A server that predates the
// parameter ignores it and the scan still finds the same traces, just slower.
async function fetchTracePage(filters: TraceListFilters, cursor: string | null, limit: number): Promise<PhoenixTracePage> {
  const phoenixQuery: Record<string, unknown> = {
    limit,
    sort: filters.sort ?? 'start_time',
    order: filters.order ?? 'desc',
    include_spans: true,
  };
  if (cursor) phoenixQuery.cursor = cursor;
  if (filters.startTime) phoenixQuery.start_time = filters.startTime;
  if (filters.endTime) phoenixQuery.end_time = filters.endTime;
  if (filters.sessionId) phoenixQuery.session_identifier = [filters.sessionId];
  if (filters.errorOnly) phoenixQuery.error = true;
  const { data, error } = await getPhoenixClient().GET('/v1/projects/{project_identifier}/traces', {
    params: { path: { project_identifier: phoenixProject().projectName }, query: phoenixQuery as never },
  });
  if (error) throw error;
  return { traces: (data?.data ?? []) as PhoenixTracePage['traces'], nextCursor: data?.next_cursor ?? null };
}

const toSummary = (t: PhoenixTracePage['traces'][number]): TraceSummary => {
  const rawSpans = (t.spans ?? []) as unknown as RawPhoenixSpan[];
  const spans = rawSpans.map(s => mapPhoenixSpan(s, t.trace_id));
  const root = spans.find(s => !s.parentId) ?? spans[0] ?? null;
  const durationMs = Number.isFinite(new Date(t.start_time).getTime()) && Number.isFinite(new Date(t.end_time).getTime())
    ? new Date(t.end_time).getTime() - new Date(t.start_time).getTime()
    : root?.durationMs ?? 0;
  return extractTraceSummary(t.trace_id, root, spans, {
    durationMs,
    timestamp: t.start_time,
    cumulativeTokens: {
      prompt: t.token_count_prompt ?? null,
      completion: t.token_count_completion ?? null,
      total: t.token_count_total ?? null,
    },
  });
};

export async function listTraces(filters: TraceListFilters): Promise<TraceListResult> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsTraceListing) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support trace listing');

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  if (env.OBSERVABILITY.REQUEST_LOG_ENABLED) return listTracesFromRequestLog(filters, limit);

  const unanswerable = NEEDS_REQUEST_LOG.filter(k => filters[k] !== undefined && filters[k] !== '');
  if (unanswerable.length > 0) {
    throw new ObservabilityError('INVALID_OBSERVABILITY_FILTER',
      `Filtering by ${unanswerable.join(', ')} needs the request log (REQUEST_LOG_ENABLED=true): Phoenix's trace list carries no span attributes.`);
  }
  const filtering = hasPageFilters(filters);

  // Each page asks for no more traces than matches are still needed, so a page
  // can never hold more than `limit` matches and Phoenix's cursor (which points
  // past the last trace it returned) never skips one.
  const matched: TraceSummary[] = [];
  let cursor: string | null = filters.cursor ?? null;
  let scanned = 0;
  for (;;) {
    const pageSize = Math.min(limit - matched.length, FILTER_SCAN_LIMIT - scanned);
    const page = await withPhoenixRetry(() => fetchTracePage(filters, cursor, pageSize));
    scanned += page.traces.length;
    const summaries = page.traces.map(toSummary);
    matched.push(...(filtering ? applyPageFilters(summaries, filters) : summaries));
    cursor = page.nextCursor;
    if (!filtering || !cursor || matched.length >= limit || scanned >= FILTER_SCAN_LIMIT) break;
  }

  return {
    traces: matched,
    nextCursor: cursor,
    appliedFilters: filters as Record<string, unknown>,
    scannedTraces: scanned,
    scanLimitReached: filtering && cursor !== null && matched.length < limit,
  };
}

export async function getTraceDetail(traceId: string): Promise<TraceDetail> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');

  const result = await withPhoenixRetry(() => getSpans({
    client: getPhoenixClient(),
    project: phoenixProject(),
    traceIds: [traceId],
    limit: 1000,
  }));

  const rawSpans = result.spans as unknown as RawPhoenixSpan[];
  if (rawSpans.length === 0) {
    throw new ObservabilityError('TRACE_NOT_FOUND', `No spans found for trace ${traceId}`);
  }

  const spans = rawSpans.map(s => mapPhoenixSpan(s, traceId)).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const root = spans.find(s => !s.parentId) ?? spans[0];
  const traceStartMs = new Date(root.startTime).getTime();
  const traceEndMs = Math.max(...spans.map(s => new Date(s.endTime).getTime()));
  const totalDurationMs = Math.max(0, traceEndMs - traceStartMs);

  const nonRootSpans = spans.filter(s => s.spanId !== root.spanId);
  const spanTree = buildSpanTree(spans, root.spanId, totalDurationMs);
  const depthById = depthMapFromTree(spanTree);
  const timeline = buildTimeline(nonRootSpans, traceStartMs, totalDurationMs, depthById);
  const criticalPath = buildCriticalPath(spanTree);
  const summary = extractTraceSummary(traceId, root, spans, { durationMs: totalDurationMs, timestamp: root.startTime });
  const [annotations, notes] = await Promise.all([
    getTraceAnnotationsFor(root.spanId).catch(() => []),
    getTraceNotesFor(root.spanId).catch(() => []),
  ]);

  return {
    summary,
    rootSpan: root,
    spans: nonRootSpans,
    spanTree,
    timeline,
    criticalPath,
    annotations,
    notes,
    phoenixTraceUrl: await buildPhoenixTraceUrl(traceId),
    // Debug/"Raw Data" tab in the admin UI, labeled "(sanitized)" — must
    // actually pass through the sanitizer like every other read-path value
    // (see sanitize.ts's header comment: phoenix.ts on export,
    // normalize.ts's mapPhoenixSpan on read). `result.spans` here is the
    // unmodified @arizeai/phoenix-client response, not the already-mapped
    // `spans` field above, so it needs its own pass.
    raw: { trace: { traceId, rootSpanId: root.spanId }, spans: sanitizeValue(result.spans) as unknown[] },
  };
}
