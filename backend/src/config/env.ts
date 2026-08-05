import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  NODE_ENV:      optional('NODE_ENV', 'development'),
  PORT:          parseInt(optional('PORT', '5000'), 10),
  FRONTEND_URL:  optional('FRONTEND_URL', 'http://localhost:3000'),

  DB: {
    HOST:     optional('DB_HOST', 'localhost'),
    PORT:     parseInt(optional('DB_PORT', '5432'), 10),
    NAME:     optional('DB_NAME', 'askaitutor'),
    USER:     optional('DB_USER', 'postgres'),
    PASSWORD: required('DB_PASSWORD'),
    URL:      optional('DATABASE_URL', ''),
  },

  JWT: {
    SECRET:              required('JWT_SECRET'),
    EXPIRES_IN:          optional('JWT_EXPIRES_IN', '15m'),
    REFRESH_SECRET:      required('JWT_REFRESH_SECRET'),
    REFRESH_EXPIRES_IN:  optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  EMAIL: {
    HOST:       optional('EMAIL_HOST', 'smtp.gmail.com'),
    PORT:       parseInt(optional('EMAIL_PORT', '587'), 10),
    SECURE:     optional('EMAIL_SECURE', 'false') === 'true',
    USER:       optional('EMAIL_USER', ''),
    PASSWORD:   optional('EMAIL_PASSWORD', ''),
    FROM_NAME:  optional('EMAIL_FROM_NAME', 'AskAITutor'),
  },

  RATE_LIMIT: {
    WINDOW_MS:    parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    MAX:          parseInt(optional('RATE_LIMIT_MAX', '100'), 10),
    AUTH_MAX:     parseInt(optional('AUTH_RATE_LIMIT_MAX', '10'), 10),
  },

  BCRYPT_SALT_ROUNDS: parseInt(optional('BCRYPT_SALT_ROUNDS', '12'), 10),

  GEMINI_API_KEY: optional('GEMINI_API_KEY', ''),

  GOOGLE: {
    CLIENT_ID:     optional('GOOGLE_CLIENT_ID', ''),
    CLIENT_SECRET: optional('GOOGLE_CLIENT_SECRET', ''),
    CALLBACK_URL:  optional('GOOGLE_CALLBACK_URL', 'http://localhost:5000/api/v1/auth/google/callback'),
  },

  RAG_MEMORY: {
    // Semantic (embedding-similarity) answer-memory reuse stays off until
    // evaluated on real lecture questions — see eval-memory-threshold.ts.
    // Exact-normalized-question reuse is unaffected by this flag.
    SEMANTIC_ENABLED: optional('RAG_MEMORY_SEMANTIC_ENABLED', 'false') === 'true',
    // No default is guessed here on purpose — an unset/invalid threshold
    // means semantic lookups are skipped safely (see rag-answer-memory.service.ts).
    SIMILARITY_THRESHOLD: process.env.RAG_MEMORY_SIMILARITY_THRESHOLD
      ? parseFloat(process.env.RAG_MEMORY_SIMILARITY_THRESHOLD)
      : null,
  },

  OBSERVABILITY: {
    // Master switch — off by default. When false, no tracing work happens
    // beyond assembling the in-memory trace object chat.service.ts always
    // builds (cheap); no Phoenix export is attempted either way unless
    // PHOENIX_ENABLED is also true.
    ENABLED: optional('OBSERVABILITY_ENABLED', 'false') === 'true',
    SAMPLE_RATE: parseFloat(optional('OBSERVABILITY_SAMPLE_RATE', '1')),
    // Opt-in content capture (truncated question/answer/chunk previews on
    // spans and in admin trace detail). Independent of NODE_ENV — operators
    // decide per-environment; see MAX_CONTENT_LENGTH for the truncation cap.
    CAPTURE_CONTENT: optional('OBSERVABILITY_CAPTURE_CONTENT', 'false') === 'true',
    MAX_CONTENT_LENGTH: parseInt(optional('OBSERVABILITY_MAX_CONTENT_LENGTH', '20000'), 10),
    RETENTION_DAYS: parseInt(optional('OBSERVABILITY_RETENTION_DAYS', '30'), 10),

    PHOENIX_ENABLED:  optional('PHOENIX_ENABLED', 'false') === 'true',
    // OTLP trace-ingestion endpoint (export path). PHOENIX_OTLP_ENDPOINT is
    // the preferred name; PHOENIX_ENDPOINT is kept as a back-compat alias
    // for existing .env files/deployments that already set it.
    PHOENIX_ENDPOINT: optional('PHOENIX_OTLP_ENDPOINT', optional('PHOENIX_ENDPOINT', '')),
    // Root URL of the Phoenix server itself (no /v1/traces suffix) — used
    // by the observability query layer to read traces back for the admin
    // UI. Separate from PHOENIX_ENDPOINT/PHOENIX_OTLP_ENDPOINT above,
    // which are the OTLP ingest path, not the server root.
    PHOENIX_BASE_URL:    optional('PHOENIX_BASE_URL', 'http://localhost:6006'),
    PHOENIX_PROJECT_NAME: optional('PHOENIX_PROJECT_NAME', 'askaitutor-rag'),
    // Optional bearer auth for both the OTLP exporter and the read-back
    // client. Never sent to the frontend — see observability.routes.ts.
    PHOENIX_API_KEY: optional('PHOENIX_API_KEY', ''),
    PHOENIX_QUERY_TIMEOUT_MS: parseInt(optional('PHOENIX_QUERY_TIMEOUT_MS', '10000'), 10),
    PHOENIX_OVERVIEW_CACHE_TTL_MS: parseInt(optional('PHOENIX_OVERVIEW_CACHE_TTL_MS', '15000'), 10),

    ALERTS_ENABLED: optional('OBSERVABILITY_ALERTS_ENABLED', 'true') === 'true',
    ALERT_ERROR_RATE_PERCENT:         parseFloat(optional('ALERT_ERROR_RATE_PERCENT', '10')),
    ALERT_P95_LATENCY_MS:             parseInt(optional('ALERT_P95_LATENCY_MS', '5000'), 10),
    ALERT_NOT_FOUND_RATE_PERCENT:     parseFloat(optional('ALERT_NOT_FOUND_RATE_PERCENT', '30')),
    ALERT_CONSECUTIVE_HEALTH_FAILURES: parseInt(optional('ALERT_CONSECUTIVE_HEALTH_FAILURES', '3'), 10),
  },

  HEALTH: {
    CACHE_TTL_MS:          parseInt(optional('HEALTH_CHECK_CACHE_TTL_MS', '60000'), 10),
    GEMINI_CHECK_ENABLED:  optional('HEALTH_GEMINI_CHECK_ENABLED', 'true') === 'true',
  },
} as const;
