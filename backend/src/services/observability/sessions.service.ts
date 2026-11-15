import { listSessions, getSessionTurns } from '@arizeai/phoenix-client/sessions';
import { getTraces } from '@arizeai/phoenix-client/traces';
import { query } from '../../config/database';
import { env } from '../../config/env';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import { mapPhoenixSpan, extractTraceSummary } from './normalize';
import { listTraceSummariesFromRequestLog } from './traces.service';
import type { RawPhoenixSpan } from './normalize';
import type { SessionSummary, SessionDetail, SessionTurn, TraceSummary } from './types';

interface RawSession {
  sessionId: string;
  startTime: string;
  endTime: string;
  traces: { traceId: string; startTime: string; endTime: string }[];
}

function summarizeFromRawSession(s: RawSession): SessionSummary {
  return {
    sessionId: s.sessionId,
    firstActivity: s.startTime,
    lastActivity: s.endTime,
    traceCount: s.traces.length,
    totalDurationMs: s.traces.reduce((sum, t) => sum + Math.max(0, new Date(t.endTime).getTime() - new Date(t.startTime).getTime()), 0),
    // Token/route/error breakdowns require per-span data, which listSessions
    // doesn't return — see getSessionDetail() below for the full picture.
    // null (not 0/[]) here — this is genuinely uncomputed for the list
    // view, not zero; making a per-list-row Phoenix call per session would
    // be an N+1 query pattern, so the UI must show "—"/"unavailable" for
    // these fields on the list and fetch the real detail page for totals.
    totalPromptTokens: null,
    totalCompletionTokens: null,
    totalTokens: null,
    successCount: null,
    errorCount: null,
    routes: null,
    lectureIds: null,
  };
}

interface SessionLogRow {
  session_id: string;
  first_activity: Date;
  last_activity: Date;
  request_count: string;
  total_ms: string;
  prompt_tokens: string;
  completion_tokens: string;
  success_count: string;
  error_count: string;
  routes: string[] | null;
  lecture_ids: (string | number)[] | null;
}

// Keyset cursor: the last row's end time and id, so paging cannot drift when
// rows are written between pages.
const encodeSessionCursor = (lastActivity: string, sessionId: string): string =>
  Buffer.from(JSON.stringify([lastActivity, sessionId])).toString('base64url');

function decodeSessionCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.length === 2 ? [String(parsed[0]), String(parsed[1])] : null;
  } catch { return null; }
}

/**
 * The session list, read from rag_request_log.
 *
 * Phoenix was the only source, which made this the last tab disagreeing with
 * the rest of the console: Phoenix keeps a shorter history, so it listed two
 * requests while the Traces tab listed five hundred. The log holds every
 * request ever made and already stores session_id, so one GROUP BY answers
 * the whole page.
 *
 * It also answers more than Phoenix could. Its own listSessions returns no
 * per-span data, so tokens, routes, lectures and the success and failure
 * counts had to be left null on every row rather than asking Phoenix once per
 * session, which would have been a query per row. Grouped in SQL they cost
 * nothing.
 *
 * created_at is written when a request finishes, so a session started
 * total_ms before its earliest row.
 */
async function listSessionsFromRequestLog(limit: number, cursor?: string | null): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const after = cursor ? decodeSessionCursor(cursor) : null;
  let keyset = '';
  if (after) {
    params.push(after[0], after[1]);
    keyset = 'HAVING (max(created_at), session_id::text) < ($1::timestamptz, $2::text)';
  }
  params.push(limit + 1);

  const { rows } = await query<SessionLogRow>(`
    SELECT session_id::text AS session_id,
           min(created_at - make_interval(secs => total_ms::float8 / 1000)) AS first_activity,
           max(created_at) AS last_activity,
           count(*) AS request_count,
           sum(total_ms) AS total_ms,
           sum(coalesce(input_tokens, 0)) AS prompt_tokens,
           sum(coalesce(output_tokens, 0)) AS completion_tokens,
           count(*) FILTER (WHERE status = 'SUCCESS') AS success_count,
           count(*) FILTER (WHERE status = 'ERROR') AS error_count,
           array_remove(array_agg(DISTINCT route), NULL) AS routes,
           array_remove(array_agg(DISTINCT lecture_id), NULL) AS lecture_ids
      FROM rag_request_log
     WHERE session_id IS NOT NULL
     GROUP BY session_id
     ${keyset}
     ORDER BY max(created_at) DESC, session_id::text DESC
     LIMIT $${params.length}`, params);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeSessionCursor(new Date(last.last_activity).toISOString(), last.session_id)
    : null;

  return {
    sessions: page.map(r => ({
      sessionId: r.session_id,
      firstActivity: new Date(r.first_activity).toISOString(),
      lastActivity: new Date(r.last_activity).toISOString(),
      traceCount: Number(r.request_count),
      totalDurationMs: Number(r.total_ms),
      totalPromptTokens: Number(r.prompt_tokens),
      totalCompletionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.prompt_tokens) + Number(r.completion_tokens),
      successCount: Number(r.success_count),
      errorCount: Number(r.error_count),
      routes: r.routes ?? [],
      lectureIds: (r.lecture_ids ?? []).map(String),
    })),
    nextCursor,
  };
}

export async function listAllSessions(limit = 25, cursor?: string | null): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> {
  // The log is the system of record and needs no Phoenix at all, so this path
  // keeps working when Phoenix is down, old or has pruned its history.
  if (env.OBSERVABILITY.REQUEST_LOG_ENABLED) return listSessionsFromRequestLog(limit, cursor);

  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsSessions) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support sessions');

  // listSessions auto-paginates internally and returns a plain array (no
  // native cursor in this client version) — bounded client-side to `limit`
  // so a project with many sessions can't pull an unbounded list into
  // memory; `nextCursor` is therefore always null (no further server-side
  // page to request) — documented limitation, not a bug.
  const all = await withPhoenixRetry(() => listSessions({ client: getPhoenixClient(), ...phoenixProject() }));
  const sorted = (all as unknown as RawSession[]).sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());
  const startIdx = cursor ? sorted.findIndex(s => s.sessionId === cursor) + 1 : 0;
  const page = sorted.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < sorted.length ? page[page.length - 1]?.sessionId ?? null : null;

  return { sessions: page.map(summarizeFromRawSession), nextCursor };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  const caps = await getPhoenixCapabilities();
  const logEnabled = env.OBSERVABILITY.REQUEST_LOG_ENABLED;
  const canUsePhoenix = caps.reachable && caps.supportsSessions;

  // Phoenix is only needed for the question and answer text now, so it is no
  // longer a reason to fail: without it the page still shows every request in
  // the conversation, read from the log.
  if (!canUsePhoenix && !logEnabled) {
    if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
    throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support sessions');
  }

  const [tracesResult, turnsResult] = await Promise.all([
    canUsePhoenix
      ? withPhoenixRetry(() => getTraces({ client: getPhoenixClient(), project: phoenixProject(), sessionId, includeSpans: true, limit: 200 }))
          .catch(() => ({ traces: [] as never[] }))
      : Promise.resolve({ traces: [] as never[] }),
    canUsePhoenix && caps.supportsSessionTurns
      ? withPhoenixRetry(() => getSessionTurns({ client: getPhoenixClient(), sessionId })).catch(() => [])
      : Promise.resolve([]),
  ]);

  let traceSummaries: TraceSummary[] = tracesResult.traces.map(t => {
    const rawSpans = (t.spans ?? []) as unknown as RawPhoenixSpan[];
    const spans = rawSpans.map(s => mapPhoenixSpan(s, t.trace_id));
    const root = spans.find(s => !s.parentId) ?? spans[0] ?? null;
    return extractTraceSummary(t.trace_id, root, spans, {
      durationMs: new Date(t.end_time).getTime() - new Date(t.start_time).getTime(),
      timestamp: t.start_time,
      cumulativeTokens: { prompt: t.token_count_prompt ?? null, completion: t.token_count_completion ?? null, total: t.token_count_total ?? null },
    });
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Phoenix had nothing for this conversation, which is ordinary once its
  // history is shorter than the log's. Every request is still recorded, so
  // the turns are rebuilt from the log; only their text is missing, and the
  // page says so per turn.
  if (traceSummaries.length === 0 && logEnabled) {
    traceSummaries = await listTraceSummariesFromRequestLog(
      { sessionId, sort: 'start_time', order: 'asc' },
      200,
    );
  }

  if (traceSummaries.length === 0) {
    throw new ObservabilityError('SESSION_NOT_FOUND', `No requests found for session ${sessionId}`);
  }

  const summary: SessionSummary = {
    sessionId,
    firstActivity: traceSummaries[0]?.timestamp ?? new Date(0).toISOString(),
    lastActivity: traceSummaries[traceSummaries.length - 1]?.timestamp ?? new Date(0).toISOString(),
    traceCount: traceSummaries.length,
    totalDurationMs: traceSummaries.reduce((sum, t) => sum + t.durationMs, 0),
    totalPromptTokens: traceSummaries.reduce((sum, t) => sum + (t.promptTokens ?? 0), 0),
    totalCompletionTokens: traceSummaries.reduce((sum, t) => sum + (t.completionTokens ?? 0), 0),
    totalTokens: traceSummaries.reduce((sum, t) => sum + (t.totalTokens ?? 0), 0),
    successCount: traceSummaries.filter(t => t.status === 'SUCCESS' || t.status === 'OK').length,
    errorCount: traceSummaries.filter(t => t.status === 'ERROR').length,
    routes: Array.from(new Set(traceSummaries.map(t => t.route).filter((r): r is string => !!r))),
    lectureIds: Array.from(new Set(traceSummaries.map(t => t.lectureId).filter((l): l is string => !!l))),
  };

  const turns: SessionTurn[] = (turnsResult as { traceId: string; startTime: string; endTime: string; input?: { value: string }; output?: { value: string } }[])
    .map(t => {
      const matched = traceSummaries.find(ts => ts.traceId === t.traceId);
      return {
        traceId: t.traceId,
        startTime: t.startTime,
        endTime: t.endTime,
        input: t.input?.value ?? matched?.questionPreview ?? null,
        output: t.output?.value ?? matched?.answerPreview ?? null,
        route: matched?.route ?? null,
        durationMs: matched?.durationMs ?? Math.max(0, new Date(t.endTime).getTime() - new Date(t.startTime).getTime()),
        status: matched?.status ?? 'UNKNOWN',
      };
    });

  return { summary, turns: turns.length > 0 ? turns : traceSummaries.map(t => ({
    traceId: t.traceId, startTime: t.timestamp, endTime: t.timestamp, input: t.questionPreview, output: t.answerPreview,
    route: t.route, durationMs: t.durationMs, status: t.status,
  })), traces: traceSummaries };
}
