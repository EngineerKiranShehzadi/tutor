import { listSessions, getSessionTurns } from '@arizeai/phoenix-client/sessions';
import { getTraces } from '@arizeai/phoenix-client/traces';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import { mapPhoenixSpan, extractTraceSummary } from './normalize';
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

export async function listAllSessions(limit = 25, cursor?: string | null): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> {
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
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsSessions) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support sessions');

  const [tracesResult, turnsResult] = await Promise.all([
    withPhoenixRetry(() => getTraces({ client: getPhoenixClient(), project: phoenixProject(), sessionId, includeSpans: true, limit: 200 })),
    caps.supportsSessionTurns
      ? withPhoenixRetry(() => getSessionTurns({ client: getPhoenixClient(), sessionId })).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (tracesResult.traces.length === 0) {
    throw new ObservabilityError('SESSION_NOT_FOUND', `No traces found for session ${sessionId}`);
  }

  const traceSummaries: TraceSummary[] = tracesResult.traces.map(t => {
    const rawSpans = (t.spans ?? []) as unknown as RawPhoenixSpan[];
    const spans = rawSpans.map(s => mapPhoenixSpan(s, t.trace_id));
    const root = spans.find(s => !s.parentId) ?? spans[0] ?? null;
    return extractTraceSummary(t.trace_id, root, spans, {
      durationMs: new Date(t.end_time).getTime() - new Date(t.start_time).getTime(),
      timestamp: t.start_time,
      cumulativeTokens: { prompt: t.token_count_prompt ?? null, completion: t.token_count_completion ?? null, total: t.token_count_total ?? null },
    });
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
