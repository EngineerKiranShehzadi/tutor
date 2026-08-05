// The installed TS config's "node" module resolution can't follow the
// package.json "exports" subpath map that @arizeai/phoenix-client/spans
// relies on for its type declarations (Node itself resolves it fine at
// runtime). This ambient declaration covers just the one export we use.
declare module '@arizeai/phoenix-client/spans' {
  import type { PhoenixClient } from '@arizeai/phoenix-client';

  export interface PhoenixSpanContext {
    trace_id: string;
    span_id: string;
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
  }

  export interface GetSpansResult {
    spans: PhoenixSpan[];
    nextCursor: string | null;
  }

  export function getSpans(params: GetSpansParams): Promise<GetSpansResult>;
}
