import { env } from '../../config/env';
import { isValidTraceId } from '../../observability/tracer';
import { logger } from '../../utils/logger';
import { getPhoenixClient, phoenixProject, withPhoenix } from './phoenix-client';

// Deep links from the admin monitor to the Phoenix UI trace page:
//   {PHOENIX_PUBLIC_URL}/projects/{projectGlobalId}/traces/{traceId}
// projectGlobalId is Phoenix's GraphQL global ID (base64 of "Project:<n>"),
// not the project name. Everything here degrades to null — a missing link
// must never fail an admin request.

const FAILURE_TTL_MS = 60_000;

// Phoenix's REST API returns the global ID in Project.id. If a server ever
// returns the bare numeric id instead, build the global ID ourselves.
export function toProjectGlobalId(id: string): string {
  return /^\d+$/.test(id) ? Buffer.from(`Project:${id}`).toString('base64') : id;
}

export function formatPhoenixTraceUrl(publicUrl: string, projectGlobalId: string, traceId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/projects/${projectGlobalId}/traces/${traceId}`;
}

// Pure null-handling around formatPhoenixTraceUrl: no public URL (feature
// off), an invalid trace ID, or an unresolved project all give null.
export function composePhoenixTraceUrl(publicUrl: string, projectGlobalId: string | null, traceId: unknown): string | null {
  if (!publicUrl.trim() || !projectGlobalId || !isValidTraceId(traceId)) return null;
  return formatPhoenixTraceUrl(publicUrl.trim(), projectGlobalId, traceId);
}

let cachedProjectId: string | null = null;
let failedAt = 0;
let inFlight: Promise<string | null> | null = null;

async function fetchProjectGlobalId(): Promise<string | null> {
  try {
    const { projectName } = phoenixProject();
    const result = await withPhoenix(() =>
      getPhoenixClient().GET('/v1/projects/{project_identifier}', {
        params: { path: { project_identifier: projectName } },
      })
    );
    const id = result.data?.data?.id;
    return id ? toProjectGlobalId(String(id)) : null;
  } catch (err) {
    logger.warn('[PHOENIX-LINKS] could not resolve Phoenix project id', err);
    return null;
  }
}

// Resolved once and cached; a failure is remembered for 60 s only so a
// restarted Phoenix is picked up. Concurrent callers share one request.
export async function resolvePhoenixProjectId(): Promise<string | null> {
  if (cachedProjectId) return cachedProjectId;
  if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) return null;
  if (!inFlight) {
    inFlight = fetchProjectGlobalId()
      .then(id => {
        if (id) cachedProjectId = id;
        else failedAt = Date.now();
        return id;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export async function buildPhoenixTraceUrl(traceId: string): Promise<string | null> {
  try {
    const publicUrl = env.OBSERVABILITY.PHOENIX_PUBLIC_URL;
    if (!publicUrl || !isValidTraceId(traceId)) return null;
    return composePhoenixTraceUrl(publicUrl, await resolvePhoenixProjectId(), traceId);
  } catch {
    return null;
  }
}

// Test hook: clears the in-memory project-id cache.
export function resetPhoenixLinksCache(): void {
  cachedProjectId = null;
  failedAt = 0;
  inFlight = null;
}
