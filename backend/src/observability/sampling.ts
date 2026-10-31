import { env } from '../config/env';
import type { FinishedTrace } from './types';
import { NON_PROBLEM_VERIFIER_REASONS } from '../rag/guardrails/output/answer-verification.types';

// Decides whether a finished trace is handed to Phoenix. PURE: no I/O; the
// random source is injectable. Interesting traces (errors, anything that was
// not a normal answer, verifier complaints, slow requests) are always
// exported; only ordinary fast answered traces are subject to the sample rate.
// rag_request_log is written for every request regardless of this decision.

export type ExportReason =
  | 'error' | 'not_answered' | 'verifier' | 'slow' | 'sampled' | 'dropped';

export interface ExportDecision {
  export: boolean;
  reason: ExportReason;
}

const NORMAL_RESPONSE_STATUSES = new Set([
  'ANSWERED', 'MEMORY_HIT_ANSWERED', 'GREETING_ANSWERED', 'SUMMARY_ANSWERED',
]);

export function decideTraceExport(
  trace: FinishedTrace,
  sampleRate: number,
  random: () => number = Math.random,
  slowTraceMs: number = env.OBSERVABILITY.SLOW_TRACE_MS
): ExportDecision {
  if (trace.status === 'ERROR') return { export: true, reason: 'error' };

  const responseStatus = trace.attributes.responseStatus;
  if (typeof responseStatus !== 'string' || !NORMAL_RESPONSE_STATUSES.has(responseStatus)) {
    return { export: true, reason: 'not_answered' };
  }

  const verification = trace.attributes.answerVerificationReason;
  // VERIFICATION_DISABLED is not a complaint: with the check off it is on every
  // answer, and force-exporting all of them would defeat the sample rate.
  if (typeof verification === 'string' && verification !== '' && !(NON_PROBLEM_VERIFIER_REASONS as readonly string[]).includes(verification)) {
    return { export: true, reason: 'verifier' };
  }

  if (trace.durationMs > slowTraceMs) return { export: true, reason: 'slow' };

  return random() < sampleRate
    ? { export: true, reason: 'sampled' }
    : { export: false, reason: 'dropped' };
}

export function shouldExportTrace(
  trace: FinishedTrace,
  sampleRate: number,
  random: () => number = Math.random,
  slowTraceMs: number = env.OBSERVABILITY.SLOW_TRACE_MS
): boolean {
  return decideTraceExport(trace, sampleRate, random, slowTraceMs).export;
}
