import { getSpanAnnotations, addSpanAnnotation, addSpanNote } from '@arizeai/phoenix-client/spans';
import { addTraceAnnotation, addTraceNote } from '@arizeai/phoenix-client/traces';
import { addSessionAnnotation, addSessionNote } from '@arizeai/phoenix-client/sessions';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { sanitizeValue } from '../../observability/sanitize';
import type { Annotation, Note } from './types';

// The installed @arizeai/phoenix-client (7.1.1) exposes WRITE functions for
// trace- and session-level annotations/notes (addTraceAnnotation,
// addTraceNote, addSessionAnnotation, addSessionNote) but no matching READ
// function for either — only span-level annotations have a getter
// (getSpanAnnotations). This is a genuine client-library capability gap,
// not a bug in this codebase: verified directly against the package's
// generated exports (dist/src/traces/index.d.ts, dist/src/sessions/
// index.d.ts contain no getTraceAnnotations/getSessionAnnotations).
//
// As a practical, clearly-labeled workaround, trace-level annotations/notes
// are read back via the trace's ROOT SPAN's annotations (Phoenix stores
// every annotation against a span_id under the hood, and addTraceAnnotation
// ultimately annotates the trace's root span) — callers get real data, not
// a fabricated placeholder, but should know the read path is span-scoped.
// Session-level annotation reads are not available at all in this client
// version — routes.ts returns an empty list with capability flags set to
// false rather than pretending the feature works.

function toAnnotation(raw: { id: string; name: string; annotator_kind: string; result?: { label?: string | null; score?: number | null } | null; metadata?: Record<string, unknown> | null; created_at: string }): Annotation {
  return {
    id: raw.id,
    name: raw.name,
    label: raw.result?.label ?? null,
    score: raw.result?.score ?? null,
    annotatorKind: raw.annotator_kind,
    // Unlike span attributes (sanitized via mapPhoenixSpan on every read
    // path), annotation metadata can originate from ANY Phoenix client —
    // not just this admin UI — so it must be sanitized here rather than
    // trusted as already-safe.
    metadata: raw.metadata ? (sanitizeValue(raw.metadata) as Record<string, unknown>) : null,
    createdAt: raw.created_at,
  };
}

export async function getSpanAnnotationsFor(spanId: string): Promise<Annotation[]> {
  const result = await withPhoenixRetry(() => getSpanAnnotations({
    client: getPhoenixClient(),
    project: phoenixProject(),
    spanIds: [spanId],
    excludeAnnotationNames: ['note'],
    limit: 100,
  }));
  return (result.annotations as never[]).map(toAnnotation);
}

export async function getSpanNotesFor(spanId: string): Promise<Note[]> {
  const result = await withPhoenixRetry(() => getSpanAnnotations({
    client: getPhoenixClient(),
    project: phoenixProject(),
    spanIds: [spanId],
    includeAnnotationNames: ['note'],
    limit: 100,
  }));
  return (result.annotations as { id: string; result?: { label?: string | null } | null; metadata?: Record<string, unknown> | null; created_at: string }[])
    .map(a => ({ id: a.id, note: String(a.metadata?.note ?? a.result?.label ?? ''), createdAt: a.created_at }));
}

// See module comment — reads the root span's annotations as a practical
// stand-in for "trace annotations" since no direct trace-annotation getter
// exists in the installed client.
export async function getTraceAnnotationsFor(rootSpanId: string | null): Promise<Annotation[]> {
  if (!rootSpanId) return [];
  return getSpanAnnotationsFor(rootSpanId);
}

export async function getTraceNotesFor(rootSpanId: string | null): Promise<Note[]> {
  if (!rootSpanId) return [];
  return getSpanNotesFor(rootSpanId);
}

export async function addAdminSpanNote(spanId: string, note: string): Promise<{ id: string }> {
  return withPhoenixRetry(() => addSpanNote({ client: getPhoenixClient(), spanNote: { spanId, note } }));
}

export async function addAdminTraceNote(traceId: string, note: string): Promise<{ id: string } | null> {
  return withPhoenixRetry(() => addTraceNote({ client: getPhoenixClient(), traceNote: { traceId, note } }));
}

export async function addAdminSessionNote(sessionId: string, note: string): Promise<{ id: string }> {
  return withPhoenixRetry(() => addSessionNote({ client: getPhoenixClient(), sessionNote: { sessionId, note } }));
}

export async function addAdminSpanAnnotation(spanId: string, name: string, label: string | null, score: number | null, adminEmail: string): Promise<{ id: string } | null> {
  return withPhoenixRetry(() => addSpanAnnotation({
    client: getPhoenixClient(),
    spanAnnotation: { spanId, name, label: label ?? undefined, score: score ?? undefined, annotatorKind: 'HUMAN', metadata: { admin: adminEmail } },
  }));
}

export async function addAdminTraceAnnotation(traceId: string, name: string, label: string | null, score: number | null, adminEmail: string): Promise<{ id: string } | null> {
  return withPhoenixRetry(() => addTraceAnnotation({
    client: getPhoenixClient(),
    traceAnnotation: { traceId, name, label: label ?? undefined, score: score ?? undefined, annotatorKind: 'HUMAN', metadata: { admin: adminEmail } },
  }));
}

export async function addAdminSessionAnnotation(sessionId: string, name: string, label: string | null, score: number | null, adminEmail: string): Promise<{ id: string } | null> {
  return withPhoenixRetry(() => addSessionAnnotation({
    client: getPhoenixClient(),
    sessionAnnotation: { sessionId, name, label: label ?? undefined, score: score ?? undefined, annotatorKind: 'HUMAN', metadata: { admin: adminEmail } },
  }));
}
