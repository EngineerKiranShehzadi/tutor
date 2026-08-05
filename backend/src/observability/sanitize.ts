import { env } from '../config/env';

// Recursive redaction/truncation for anything that might end up on a Phoenix
// span (export path) or come back from Phoenix into an admin API response
// (read path). Two independent call sites use this — see phoenix.ts and
// services/observability/normalize.ts — so a key added to the denylist
// protects both directions at once.

// Deliberately specific (not bare "token"/"auth") — a bare substring match
// would also catch legitimate telemetry fields like "llm.token_count.
// prompt" or "authorPromptVersion" and silently hide real, safe data. Real
// bearer/JWT/API-key-shaped *values* are still caught regardless of key
// name via SENSITIVE_VALUE_PATTERNS below — that's the more precise line
// of defense for anything this key list doesn't happen to name.
const DENYLIST_KEYS = [
  'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesstoken',
  'access_token', 'refreshtoken', 'refresh_token', 'authtoken', 'auth_token',
  'authorization', 'cookie', 'session_secret', 'jwt', 'privatekey',
  'private_key', 'otp', 'client_secret', 'clientsecret', 'database_url',
  'db_password', 'dsn', 'x-api-key',
];

// Bearer tokens, JWTs (three base64url segments), and connection-string-like
// values (scheme://user:pass@host) — matched even when the key name itself
// looks innocuous (e.g. a nested "value" field holding a copied header).
const SENSITIVE_VALUE_PATTERNS = [
  /^bearer\s+[a-z0-9._-]+$/i,
  /^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i, // JWT-shaped
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s@]*@/i, // scheme://user:pass@...
  /^sk-[a-z0-9]{16,}$/i, // common API-key prefix shape (OpenAI/Anthropic/etc.)
];

const REDACTED = '[REDACTED]';
const TRUNCATED_SUFFIX = '…[truncated]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

function isDenylistedKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_ ]/g, '');
  return DENYLIST_KEYS.some(d => k.includes(d.replace(/[-_ ]/g, '')));
}

function looksSensitive(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some(re => re.test(value.trim()));
}

export interface TruncateResult {
  value: string;
  truncated: boolean;
}

// Safe to call directly on a piece of content (question/answer/chunk text)
// that has already passed the capture-content gate. Content that fails the
// gate should never reach this function at all — callers must check
// isContentCaptureEnabled() first and substitute metadata (length/hash)
// instead of calling truncateContent().
export function truncateContent(value: string, maxLength = env.OBSERVABILITY.MAX_CONTENT_LENGTH): TruncateResult {
  if (value.length <= maxLength) return { value, truncated: false };
  return { value: value.slice(0, maxLength) + TRUNCATED_SUFFIX, truncated: true };
}

export function isContentCaptureEnabled(): boolean {
  return env.OBSERVABILITY.CAPTURE_CONTENT;
}

// Recursively redacts denylisted keys / secret-shaped values and truncates
// long strings, bounding depth/array/object size so a malformed or huge
// Phoenix payload can never cause runaway recursion or a multi-MB response.
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH_EXCEEDED]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (looksSensitive(value)) return REDACTED;
    return truncateContent(value).value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(v => sanitizeValue(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more, truncated]`);
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, v] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (isDenylistedKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = sanitizeValue(v, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    return out;
  }

  // function/symbol/bigint etc. — never safe to serialize as-is.
  return String(value);
}

// Sanitizes a flat attribute bag (the shape every span/trace attribute set
// in this codebase actually is) without the array/object recursion overhead
// needed for arbitrary nested Phoenix payloads.
export function sanitizeAttributes<T extends Record<string, unknown>>(attrs: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = isDenylistedKey(key) ? REDACTED : sanitizeValue(value, 1);
  }
  return out;
}
