import { createClient, type PhoenixClient } from '@arizeai/phoenix-client';
import { getSpans } from '@arizeai/phoenix-client/spans';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface RagTraceSummary {
  traceId: string;
  spanId: string;
  name: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

export interface RagTraceSpan {
  spanId: string;
  parentId: string | null;
  name: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

let client: PhoenixClient | null = null;

function getClient(): PhoenixClient {
  if (!client) {
    client = createClient({ options: { baseUrl: env.OBSERVABILITY.PHOENIX_BASE_URL } });
  }
  return client;
}

function durationMs(startTime: string, endTime: string): number {
  return new Date(endTime).getTime() - new Date(startTime).getTime();
}

// Lists recent RAG request traces by reading root spans (parentId === null)
// straight from Phoenix — each root span already carries the full set of
// attributes chat.service.ts recorded on the trace (route, status, etc.),
// so no separate trace lookup is needed for the summary view.
export async function listRagTraces(limit = 50): Promise<RagTraceSummary[]> {
  const { spans } = await getSpans({
    client: getClient(),
    project: { projectName: env.OBSERVABILITY.PHOENIX_PROJECT_NAME },
    parentId: null,
    limit,
  });

  return spans
    .map((span) => ({
      traceId: span.context.trace_id,
      spanId: span.context.span_id,
      name: span.name,
      status: span.status_code,
      startedAt: span.start_time,
      durationMs: durationMs(span.start_time, span.end_time),
      attributes: span.attributes ?? {},
    }))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export async function getRagTraceSpans(traceId: string): Promise<RagTraceSpan[]> {
  const { spans } = await getSpans({
    client: getClient(),
    project: { projectName: env.OBSERVABILITY.PHOENIX_PROJECT_NAME },
    traceIds: [traceId],
  });

  return spans
    .map((span) => ({
      spanId: span.context.span_id,
      parentId: span.parent_id ?? null,
      name: span.name,
      status: span.status_code,
      startedAt: span.start_time,
      durationMs: durationMs(span.start_time, span.end_time),
      attributes: span.attributes ?? {},
    }))
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

export async function checkPhoenixReachable(): Promise<boolean> {
  try {
    await getClient().getServerVersion();
    return true;
  } catch (err) {
    logger.warn(`[PHOENIX] Server unreachable at ${env.OBSERVABILITY.PHOENIX_BASE_URL}: ${(err as Error).message}`);
    return false;
  }
}
