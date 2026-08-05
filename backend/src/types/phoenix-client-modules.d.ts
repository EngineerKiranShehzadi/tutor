// The installed TS config's "node" module resolution can't follow the
// package.json "exports" subpath map that @arizeai/phoenix-client's
// /spans, /traces, and /sessions entry points rely on for their type
// declarations (Node itself resolves them fine at runtime — this is a
// types-only gap). These ambient declarations cover exactly the exports
// this codebase actually imports, hand-typed against the real installed
// .d.ts files (dist/src/{spans,traces,sessions}/*.d.ts,
// dist/src/__generated__/api/v1.d.ts) in @arizeai/phoenix-client@7.1.1 —
// not guessed from documentation. Revisit if the client is upgraded, or
// switch tsconfig's moduleResolution to "bundler"/"node16" and delete this
// file entirely.

declare module '@arizeai/phoenix-client/spans' {
  import type { PhoenixClient } from '@arizeai/phoenix-client';

  export interface PhoenixSpanContext {
    trace_id: string;
    span_id: string;
  }

  export interface PhoenixSpanEvent {
    name: string;
    timestamp: string;
    attributes?: Record<string, unknown>;
  }

  export interface PhoenixSpan {
    id: string;
    name: string;
    context: PhoenixSpanContext;
    span_kind: string;
    parent_id?: string | null;
    start_time: string;
    end_time: string;
    status_code: string;
    status_message?: string;
    attributes?: Record<string, unknown>;
    events?: PhoenixSpanEvent[];
  }

  export interface GetSpansParams {
    client?: PhoenixClient;
    project: { project: string } | { projectId: string } | { projectName: string };
    startTime?: Date | string | null;
    endTime?: Date | string | null;
    cursor?: string | null;
    limit?: number;
    traceIds?: string[] | null;
    spanIds?: string[] | null;
    parentId?: string | null;
    name?: string | string[] | null;
    spanKind?: string | string[] | null;
    statusCode?: string | string[] | null;
    attributes?: Record<string, string | number | boolean> | null;
  }

  export interface GetSpansResult {
    spans: PhoenixSpan[];
    nextCursor: string | null;
  }

  export function getSpans(params: GetSpansParams): Promise<GetSpansResult>;

  export interface PhoenixAnnotationResult {
    label?: string | null;
    score?: number | null;
    explanation?: string | null;
  }

  export interface PhoenixAnnotation {
    id: string;
    created_at: string;
    updated_at: string;
    source: 'API' | 'APP';
    user_id: string | null;
    name: string;
    annotator_kind: 'LLM' | 'CODE' | 'HUMAN';
    result?: PhoenixAnnotationResult | null;
    metadata?: Record<string, unknown> | null;
    identifier?: string;
    span_id: string;
  }

  export interface SpanAnnotation {
    name: string;
    label?: string;
    score?: number;
    explanation?: string;
    identifier?: string;
    metadata?: Record<string, unknown>;
    spanId: string;
    annotatorKind?: 'HUMAN' | 'LLM' | 'CODE';
  }

  export interface AddSpanAnnotationParams {
    client?: PhoenixClient;
    spanAnnotation: SpanAnnotation;
    sync?: boolean;
  }

  export function addSpanAnnotation(params: AddSpanAnnotationParams): Promise<{ id: string } | null>;

  export interface GetSpanAnnotationsParams {
    client?: PhoenixClient;
    project: { project: string } | { projectId: string } | { projectName: string };
    spanIds: string[];
    includeAnnotationNames?: string[];
    excludeAnnotationNames?: string[];
    cursor?: string | null;
    limit?: number;
  }

  export interface GetSpanAnnotationsResult {
    annotations: PhoenixAnnotation[];
    nextCursor: string | null;
  }

  export function getSpanAnnotations(params: GetSpanAnnotationsParams): Promise<GetSpanAnnotationsResult>;

  export interface SpanNote {
    spanId: string;
    note: string;
    identifier?: string;
  }

  export interface AddSpanNoteParams {
    client?: PhoenixClient;
    spanNote: SpanNote;
  }

  export function addSpanNote(params: AddSpanNoteParams): Promise<{ id: string }>;
}

declare module '@arizeai/phoenix-client/traces' {
  import type { PhoenixClient } from '@arizeai/phoenix-client';
  import type { PhoenixSpan } from '@arizeai/phoenix-client/spans';

  export interface TraceData {
    id: string;
    trace_id: string;
    project_id: string;
    start_time: string;
    end_time: string;
    token_count_prompt?: number;
    token_count_completion?: number;
    token_count_total?: number;
    spans?: PhoenixSpan[] | null;
  }

  export interface GetTracesParams {
    client?: PhoenixClient;
    project: { project: string } | { projectId: string } | { projectName: string };
    startTime?: Date | string | null;
    endTime?: Date | string | null;
    sort?: 'start_time' | 'latency_ms';
    order?: 'asc' | 'desc';
    limit?: number;
    cursor?: string | null;
    includeSpans?: boolean;
    sessionId?: string | string[] | null;
  }

  export interface GetTracesResult {
    traces: TraceData[];
    nextCursor: string | null;
  }

  export function getTraces(params: GetTracesParams): Promise<GetTracesResult>;

  export interface TraceAnnotation {
    name: string;
    label?: string;
    score?: number;
    explanation?: string;
    identifier?: string;
    metadata?: Record<string, unknown>;
    traceId: string;
    annotatorKind?: 'HUMAN' | 'LLM' | 'CODE';
  }

  export interface AddTraceAnnotationParams {
    client?: PhoenixClient;
    traceAnnotation: TraceAnnotation;
    sync?: boolean;
  }

  export function addTraceAnnotation(params: AddTraceAnnotationParams): Promise<{ id: string } | null>;

  export interface TraceNote {
    traceId: string;
    note: string;
    identifier?: string;
  }

  export interface AddTraceNoteParams {
    client?: PhoenixClient;
    traceNote: TraceNote;
  }

  export function addTraceNote(params: AddTraceNoteParams): Promise<{ id: string }>;
}

declare module '@arizeai/phoenix-client/sessions' {
  import type { PhoenixClient } from '@arizeai/phoenix-client';

  export interface SessionTrace {
    id: string;
    traceId: string;
    startTime: string;
    endTime: string;
  }

  export interface Session {
    id: string;
    sessionId: string;
    projectId: string;
    startTime: string;
    endTime: string;
    traces: SessionTrace[];
  }

  export type ListSessionsParams = {
    client?: PhoenixClient;
  } & ({ project: string } | { projectId: string } | { projectName: string });

  export function listSessions(params: ListSessionsParams): Promise<Session[]>;

  export interface GetSessionParams {
    client?: PhoenixClient;
    sessionId: string;
  }

  export function getSession(params: GetSessionParams): Promise<Session>;

  export interface SessionTurnIO {
    value: string;
    mimeType?: string;
  }

  export interface SessionTurn {
    traceId: string;
    startTime: string;
    endTime: string;
    input?: SessionTurnIO;
    output?: SessionTurnIO;
  }

  export interface GetSessionTurnsParams {
    client?: PhoenixClient;
    sessionId: string;
  }

  export function getSessionTurns(params: GetSessionTurnsParams): Promise<SessionTurn[]>;

  export interface SessionAnnotation {
    name: string;
    label?: string;
    score?: number;
    explanation?: string;
    identifier?: string;
    metadata?: Record<string, unknown>;
    sessionId: string;
    annotatorKind?: 'HUMAN' | 'LLM' | 'CODE';
  }

  export interface AddSessionAnnotationParams {
    client?: PhoenixClient;
    sessionAnnotation: SessionAnnotation;
    sync?: boolean;
  }

  export function addSessionAnnotation(params: AddSessionAnnotationParams): Promise<{ id: string } | null>;

  export interface SessionNote {
    sessionId: string;
    note: string;
    identifier?: string;
  }

  export interface AddSessionNoteParams {
    client?: PhoenixClient;
    sessionNote: SessionNote;
  }

  export function addSessionNote(params: AddSessionNoteParams): Promise<{ id: string }>;
}

declare module '@arizeai/phoenix-client/types/serverRequirements' {
  export type SemanticVersion = [number, number, number];

  export interface RouteRequirement {
    kind: 'route';
    method: string;
    path: string;
    minServerVersion: SemanticVersion;
    description?: string;
  }

  export interface ParameterRequirement {
    kind: 'parameter';
    parameterName: string;
    parameterLocation: string;
    route: string;
    minServerVersion: SemanticVersion;
    description?: string;
  }

  export type CapabilityRequirement = RouteRequirement | ParameterRequirement;
}

declare module '@arizeai/phoenix-client/utils/serverVersionUtils' {
  import type { PhoenixClient } from '@arizeai/phoenix-client';
  import type { CapabilityRequirement } from '@arizeai/phoenix-client/types/serverRequirements';

  export function capabilityLabel(req: CapabilityRequirement): string;

  export function ensureServerCapability(params: {
    client: PhoenixClient;
    requirement: CapabilityRequirement;
  }): Promise<void>;
}
