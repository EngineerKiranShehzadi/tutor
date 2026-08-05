// Stable, typed error codes for the observability API layer — routes map
// these to consistent HTTP status codes and response envelopes instead of
// letting raw Phoenix/network errors leak to the admin UI.
export type ObservabilityErrorCode =
  | 'PHOENIX_DISABLED'
  | 'PHOENIX_UNREACHABLE'
  | 'PHOENIX_TIMEOUT'
  | 'PHOENIX_UNSUPPORTED_FEATURE'
  | 'TRACE_NOT_FOUND'
  | 'SPAN_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_OBSERVABILITY_FILTER';

const STATUS_BY_CODE: Record<ObservabilityErrorCode, number> = {
  PHOENIX_DISABLED: 409,
  PHOENIX_UNREACHABLE: 502,
  PHOENIX_TIMEOUT: 504,
  PHOENIX_UNSUPPORTED_FEATURE: 501,
  TRACE_NOT_FOUND: 404,
  SPAN_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  INVALID_OBSERVABILITY_FILTER: 400,
};

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly statusCode: number;

  constructor(code: ObservabilityErrorCode, message: string) {
    super(message);
    this.name = 'ObservabilityError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export function isObservabilityError(err: unknown): err is ObservabilityError {
  return err instanceof ObservabilityError;
}

// Wraps an arbitrary thrown error (network failure, Phoenix client
// exception, etc.) into a stable ObservabilityError — never lets a raw
// provider error/stack trace reach the admin UI.
export function toObservabilityError(err: unknown, fallbackCode: ObservabilityErrorCode = 'PHOENIX_UNREACHABLE'): ObservabilityError {
  if (isObservabilityError(err)) return err;
  const msg = String((err as Error)?.message ?? 'Unknown Phoenix error').toLowerCase();
  if (msg.includes('timeout') || msg.includes('aborted')) return new ObservabilityError('PHOENIX_TIMEOUT', 'Phoenix query timed out');
  if (msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network')) {
    return new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  }
  // @arizeai/phoenix-client's own ensureServerCapability() throws exactly
  // this phrase (see serverVersionUtils.js) when the connected server is
  // too old for the requested call — a genuinely different situation from
  // "unreachable" and worth its own 501, not a generic 502.
  if (msg.includes('requires phoenix server')) {
    return new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support the requested feature');
  }
  return new ObservabilityError(fallbackCode, 'Phoenix query failed');
}
