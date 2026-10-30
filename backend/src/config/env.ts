import dotenv from 'dotenv';
import path from 'path';
import type { LlmThinking } from '../llm/llm.types';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const nonNegativeInt = (key: string, fallback: number): number => {
  const n = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Per-task thinking effort (off|minimal|low|medium|high). An unrecognised
// value falls back to the task's default rather than failing boot.
const THINKING_LEVELS: readonly LlmThinking[] = ['off', 'minimal', 'low', 'medium', 'high'];
const thinking = (key: string, fallback: LlmThinking): LlmThinking => {
  const raw = (process.env[key] ?? '').trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(raw) ? (raw as LlmThinking) : fallback;
};

export interface LlmPrice { inputPer1M: number; outputPer1M: number }

// LLM_PRICING_JSON: {"<model>":{"inputPer1M":<usd>,"outputPer1M":<usd>}}.
// Malformed JSON or entries are ignored (never throw at boot); a model with
// no valid entry simply gets est_cost_usd = NULL in rag_request_log.
const parseLlmPricing = (raw: string): Record<string, LlmPrice> => {
  const out: Record<string, LlmPrice> = {};
  if (!raw.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, { inputPer1M?: unknown; outputPer1M?: unknown }>;
    for (const [model, p] of Object.entries(parsed ?? {})) {
      if (
        typeof p?.inputPer1M === 'number' && Number.isFinite(p.inputPer1M) && p.inputPer1M >= 0 &&
        typeof p?.outputPer1M === 'number' && Number.isFinite(p.outputPer1M) && p.outputPer1M >= 0
      ) {
        out[model] = { inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M };
      }
    }
  } catch {
    // ignore — see comment above
  }
  return out;
};

export const env = {
  NODE_ENV:      optional('NODE_ENV', 'development'),
  PORT:          parseInt(optional('PORT', '5000'), 10),
  FRONTEND_URL:  optional('FRONTEND_URL', 'http://localhost:3000'),
  // Upper bound for a graceful shutdown (SIGTERM/SIGINT): finishing in-flight
  // requests, flushing traces to Phoenix and closing the DB pool. If it is
  // not done by then, the process exits with code 1. See server.ts.
  SHUTDOWN_TIMEOUT_MS: parseInt(optional('SHUTDOWN_TIMEOUT_MS', '10000'), 10),

  // Production only: also write logs/error.log and logs/combined.log (10 MB
  // size rotation, 5 files). Off by default — production logs go to the
  // console as JSON. See utils/logger.ts.
  LOG_TO_FILE: optional('LOG_TO_FILE', 'false') === 'true',

  // Dataset pipeline (dataset-version.service.ts). How long to wait before
  // retrying a build that is paused because the embedding service is down.
  DATASET: {
    RETRY_DELAY_MS: parseInt(optional('DATASET_RETRY_DELAY_MS', '15000'), 10),
    // Chunks per embedding request; 1 = per-chunk (/embed). Batching is meant for a
    // GPU or a remote embedder; on a CPU-only box it is slower. Measured on the
    // local CPU server, lecture 4 (329 chunks): per-chunk 111 s, batch 8 128 s,
    // batch 32 158 s; vectors identical (min cosine 0.9999999999991).
    EMBED_BATCH: Math.max(1, parseInt(optional('DATASET_EMBED_BATCH', '1'), 10) || 1),
  },

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

  // Raw dataset archival only — see services/s3-storage.service.ts. Not
  // read anywhere else in the app. Left unset by default (unlike
  // GEMINI_API_KEY, not `required()`) so the app still boots without AWS
  // configured; the upload endpoint fails fast with a clear error only if
  // a dataset is actually uploaded before these are set.
  S3: {
    BUCKET_NAME:      optional('S3_DATASET_BUCKET', ''),
    REGION:           optional('S3_REGION', optional('AWS_REGION', '')),
    ACCESS_KEY_ID:    optional('AWS_ACCESS_KEY_ID', ''),
    SECRET_ACCESS_KEY: optional('AWS_SECRET_ACCESS_KEY', ''),
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
    // Traces slower than this are always exported to Phoenix, whatever
    // SAMPLE_RATE says (see observability/sampling.ts).
    SLOW_TRACE_MS: parseInt(optional('OBSERVABILITY_SLOW_TRACE_MS', '10000'), 10),
    // Opt-in content capture (truncated question/answer/chunk previews on
    // spans and in admin trace detail). Independent of NODE_ENV — operators
    // decide per-environment; see MAX_CONTENT_LENGTH for the truncation cap.
    CAPTURE_CONTENT: optional('OBSERVABILITY_CAPTURE_CONTENT', 'false') === 'true',
    MAX_CONTENT_LENGTH: parseInt(optional('OBSERVABILITY_MAX_CONTENT_LENGTH', '20000'), 10),
    RETENTION_DAYS: parseInt(optional('OBSERVABILITY_RETENTION_DAYS', '90'), 10),

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
    // Phoenix URL an admin opens in their browser (may differ from
    // PHOENIX_BASE_URL, the backend-to-Phoenix URL). Empty = no trace links
    // in /monitor/attention. Trailing slash stripped.
    PHOENIX_PUBLIC_URL: optional('PHOENIX_PUBLIC_URL', '').trim().replace(/\/+$/, ''),
    // Optional bearer auth for both the OTLP exporter and the read-back
    // client. Never sent to the frontend — see observability.routes.ts.
    PHOENIX_API_KEY: optional('PHOENIX_API_KEY', ''),
    PHOENIX_QUERY_TIMEOUT_MS: parseInt(optional('PHOENIX_QUERY_TIMEOUT_MS', '10000'), 10),
    PHOENIX_OVERVIEW_CACHE_TTL_MS: parseInt(optional('PHOENIX_OVERVIEW_CACHE_TTL_MS', '15000'), 10),

    // One rag_request_log row per askLectureAgent call (see
    // observability/request-log.service.ts). Postgres-only; independent of
    // Phoenix. A failed write only logs a warning.
    REQUEST_LOG_ENABLED: optional('REQUEST_LOG_ENABLED', 'true') === 'true',
    // Per-model USD prices used to fill rag_request_log.est_cost_usd. Unknown
    // model or missing token counts -> NULL, never a guess.
    LLM_PRICING: parseLlmPricing(optional('LLM_PRICING_JSON', '')),

    ALERTS_ENABLED: optional('OBSERVABILITY_ALERTS_ENABLED', 'false') === 'true',
    // Email alert rules (observability/alerts.service.ts). Rates are 0..1.
    ALERT_CHECK_INTERVAL_MS: parseInt(optional('ALERT_CHECK_INTERVAL_MS', '300000'), 10),
    ALERT_WINDOW_MINUTES:    parseInt(optional('ALERT_WINDOW_MINUTES', '15'), 10),
    ALERT_MIN_REQUESTS:      parseInt(optional('ALERT_MIN_REQUESTS', '20'), 10),
    ALERT_COOLDOWN_MINUTES:  parseInt(optional('ALERT_COOLDOWN_MINUTES', '60'), 10),
    ALERT_ERROR_RATE:        parseFloat(optional('ALERT_ERROR_RATE', '0.05')),
    ALERT_NOT_FOUND_RATE:    parseFloat(optional('ALERT_NOT_FOUND_RATE', '0.40')),
    ALERT_P95_MS:            parseInt(optional('ALERT_P95_MS', '15000'), 10),
    // Comma-separated; empty = every user with role ADMIN.
    ALERT_EMAILS: optional('ALERT_EMAILS', '').split(',').map(e => e.trim()).filter(Boolean),
    ALERT_CONSECUTIVE_HEALTH_FAILURES: parseInt(optional('ALERT_CONSECUTIVE_HEALTH_FAILURES', '3'), 10),
  },

  HEALTH: {
    CACHE_TTL_MS:          parseInt(optional('HEALTH_CHECK_CACHE_TTL_MS', '60000'), 10),
    GEMINI_CHECK_ENABLED:  optional('HEALTH_GEMINI_CHECK_ENABLED', 'true') === 'true',
  },

  // ── Groq (TEMPORARY free-tier test provider; see llm/providers/groq-llm.provider.ts) ──
  // Only used when a service's *_PROVIDER is set to 'groq'. Gemini stays the default everywhere.
  // The limits below are CLIENT-SIDE ceilings kept under the free-tier numbers for openai/gpt-oss-120b
  // (about 30 requests/min, 8,000 tokens/min, 200,000 tokens/day); Groq's own response headers tighten them further.
  GROQ: {
    API_KEY:            optional('GROQ_API_KEY', ''),
    BASE_URL:           optional('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    MAX_RPM:            parseInt(optional('GROQ_MAX_RPM', '20'), 10),
    MAX_TPM:            parseInt(optional('GROQ_MAX_TPM', '7000'), 10),
    // Hard stop for one process lifetime so a test run can never eat the whole daily allowance.
    RUN_TOKEN_BUDGET:   parseInt(optional('GROQ_RUN_TOKEN_BUDGET', '120000'), 10),
    // A retry-after longer than this is a daily/long limit: fail clearly instead of sleeping for hours.
    MAX_WAIT_MS:        parseInt(optional('GROQ_MAX_WAIT_MS', '90000'), 10),
    REASONING_EFFORT:   optional('GROQ_REASONING_EFFORT', 'low'),
    // gpt-oss counts its reasoning inside max_completion_tokens: never ask for less than this floor.
    MIN_COMPLETION_TOKENS: parseInt(optional('GROQ_MIN_COMPLETION_TOKENS', '1024'), 10),
  },

  // ── Provider-neutral LLM configuration ─────────────────────────
  // Every LLM-dependent service picks its provider+model from here rather
  // than hardcoding either — see src/llm/llm-provider.resolver.ts. Gemini is
  // the only provider actually implemented today (src/llm/providers/
  // gemini-llm.provider.ts); the resolver throws a clear error for any other
  // PROVIDER value until a matching adapter is added.
  LLM: {
    RAG_ANSWER: {
      PROVIDER:        optional('RAG_LLM_PROVIDER', 'gemini'),
      MODEL:           optional('RAG_ANSWER_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('RAG_ANSWER_THINKING', 'low'),
      // Used once retry attempts exceed llm-gemini.service.ts's own
      // attempt<=2 threshold — preserves today's exact gemini-2.5-flash ->
      // gemini-flash-latest fallback chain by default.
      FALLBACK_MODEL:  optional('RAG_ANSWER_FALLBACK_MODEL', 'gemini-flash-latest'),
    },
    QUERY_ROUTER: {
      PROVIDER: optional('QUERY_ROUTER_LLM_PROVIDER', 'gemini'),
      MODEL:    optional('QUERY_ROUTER_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('QUERY_ROUTER_THINKING', 'minimal'),
    },
    // Natural reply to greetings/small talk (services/greeting-response.
    // service.ts). Higher temperature than the classifiers so replies vary;
    // falls back to a fixed message if the call fails.
    GREETING: {
      PROVIDER:    optional('GREETING_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('GREETING_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('GREETING_THINKING', 'minimal'),
      TIMEOUT_MS:  parseInt(optional('GREETING_LLM_TIMEOUT_MS', '6000'), 10),
      TEMPERATURE: parseFloat(optional('GREETING_LLM_TEMPERATURE', '0.7')),
    },
    QUERY_REWRITE: {
      PROVIDER: optional('QUERY_REWRITE_LLM_PROVIDER', 'gemini'),
      MODEL:    optional('QUERY_REWRITE_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('QUERY_REWRITE_THINKING', 'minimal'),
    },
    LECTURE_SUMMARY: {
      PROVIDER: optional('LECTURE_SUMMARY_LLM_PROVIDER', 'gemini'),
      MODEL:    optional('LECTURE_SUMMARY_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('LECTURE_SUMMARY_THINKING', 'low'),
    },
    GUARDRAIL: {
      // Separate from INPUT_GUARDRAIL_INJECTION_ENABLED below: that flag
      // controls whether PromptInjectionGuard runs at all; this one controls
      // whether its Stage B semantic classifier may be used for genuinely
      // ambiguous input once Stage A's deterministic signals can't decide.
      ENABLED:     optional('GUARDRAIL_LLM_ENABLED', 'true') === 'true',
      PROVIDER:    optional('GUARDRAIL_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('GUARDRAIL_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('GUARDRAIL_THINKING', 'minimal'),
      TIMEOUT_MS:  parseInt(optional('GUARDRAIL_LLM_TIMEOUT_MS', '4000'), 10),
      TEMPERATURE: parseFloat(optional('GUARDRAIL_LLM_TEMPERATURE', '0')),
    },
    // Used by the single DIRECT/DECOMPOSE structured-output call in
    // rag/query-processing/decomposition/subquery-decomposition.service.ts —
    // only reached for candidate compound queries (see compound-query.
    // detector.ts), never on every question.
    QUERY_DECOMPOSITION: {
      PROVIDER:    optional('QUERY_DECOMPOSITION_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('QUERY_DECOMPOSITION_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('QUERY_DECOMPOSITION_THINKING', 'minimal'),
      TIMEOUT_MS:  parseInt(optional('QUERY_DECOMPOSITION_LLM_TIMEOUT_MS', '4000'), 10),
      TEMPERATURE: parseFloat(optional('QUERY_DECOMPOSITION_LLM_TEMPERATURE', '0')),
    },
    // Used by the STOP/RETRIEVE planner in rag/query-processing/
    // adaptive-retrieval/adaptive-retrieval-planner.service.ts — only
    // reached when Selective Subquery Decomposition already found an
    // uncovered aspect via its existing deterministic coverage signal,
    // never on every question and never as a second call for a query
    // decomposition already resolved.
    ADAPTIVE_RETRIEVAL: {
      PROVIDER:    optional('ADAPTIVE_RETRIEVAL_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('ADAPTIVE_RETRIEVAL_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('ADAPTIVE_RETRIEVAL_THINKING', 'minimal'),
      TIMEOUT_MS:  parseInt(optional('ADAPTIVE_RETRIEVAL_LLM_TIMEOUT_MS', '4000'), 10),
      TEMPERATURE: parseFloat(optional('ADAPTIVE_RETRIEVAL_LLM_TEMPERATURE', '0')),
    },
    // Used by both the groundedness verifier and the bounded revision
    // rewrite in rag/guardrails/output/ — deliberately independent of
    // RAG_ANSWER_MODEL (the generator) so a different/cheaper/stricter
    // model can judge/correct output without touching generation config.
    ANSWER_VERIFICATION: {
      PROVIDER:    optional('ANSWER_VERIFICATION_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('ANSWER_VERIFICATION_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('ANSWER_VERIFICATION_THINKING', 'off'),
      TIMEOUT_MS:  parseInt(optional('ANSWER_VERIFICATION_LLM_TIMEOUT_MS', '8000'), 10),
      TEMPERATURE: parseFloat(optional('ANSWER_VERIFICATION_LLM_TEMPERATURE', '0')),
    },
    // Used only when Selective Output Format Validation finds a grounded
    // answer that doesn't structurally match an explicitly requested
    // LIST/TABLE — see rag/guardrails/output/format/response-format-repair.
    // service.ts. Most LIST cases never reach this call at all (a cheap
    // deterministic repair handles the common case first). Deliberately
    // independent of RAG_ANSWER_MODEL/ANSWER_VERIFICATION_MODEL — this only
    // ever reformats, never regenerates or re-judges content.
    OUTPUT_FORMAT_REPAIR: {
      PROVIDER:    optional('OUTPUT_FORMAT_REPAIR_LLM_PROVIDER', 'gemini'),
      MODEL:       optional('OUTPUT_FORMAT_REPAIR_LLM_MODEL', 'gemini-2.5-flash'),
      THINKING: thinking('OUTPUT_FORMAT_REPAIR_THINKING', 'minimal'),
      TIMEOUT_MS:  parseInt(optional('OUTPUT_FORMAT_REPAIR_LLM_TIMEOUT_MS', '4000'), 10),
      TEMPERATURE: parseFloat(optional('OUTPUT_FORMAT_REPAIR_LLM_TEMPERATURE', '0')),
    },
  },

  // ── Input Guardrail (pre-query) ─────────────────────────────────
  // Runs before query-router.service.ts — see rag/guardrails/input/
  // input-guardrail.service.ts. Application-level limits, deliberately
  // independent of whatever context window the configured model supports.
  CHAT: {
    // How many prior turns of the session are passed to the router, rewriter
    // and answer prompt as follow-up context. 0 disables history.
    HISTORY_TURNS: nonNegativeInt('CHAT_HISTORY_TURNS', 10),
  },

  INPUT_GUARDRAIL: {
    ENABLED:                  optional('INPUT_GUARDRAIL_ENABLED', 'true') === 'true',
    MAX_CHARS:                parseInt(optional('INPUT_GUARDRAIL_MAX_CHARS', '8000'), 10),
    MAX_TOKENS:               parseInt(optional('INPUT_GUARDRAIL_MAX_TOKENS', '2000'), 10),
    PII_ENABLED:              optional('INPUT_GUARDRAIL_PII_ENABLED', 'true') === 'true',
    INJECTION_ENABLED:        optional('INPUT_GUARDRAIL_INJECTION_ENABLED', 'true') === 'true',
    MALICIOUS_PAYLOAD_ENABLED: optional('INPUT_GUARDRAIL_MALICIOUS_PAYLOAD_ENABLED', 'true') === 'true',
  },

  // ── Selective Subquery Decomposition ────────────────────────────
  // Runs after routing/history-rewriting, on the effective self-contained
  // query — see rag/query-processing/decomposition/subquery-decomposition.
  // service.ts. A cheap deterministic gate (compound-query.detector.ts)
  // decides whether a query is even a candidate before any LLM call is
  // made, so this never adds latency to an ordinary question.
  QUERY_DECOMPOSITION: {
    ENABLED: optional('QUERY_DECOMPOSITION_ENABLED', 'true') === 'true',
    // Hard cap on fan-out — deliberately small; see subquery-decomposition.
    // prompt.ts's instruction to use the smallest useful number of
    // subqueries.
    MAX_SUBQUERIES: parseInt(optional('QUERY_DECOMPOSITION_MAX_SUBQUERIES', '3'), 10),
  },

  // ── Iterative Adaptive Retrieval ─────────────────────────────────
  // Runs only when Selective Subquery Decomposition's existing coverage
  // signal already found a real evidence gap (one or more uncovered
  // subqueries) — see rag/query-processing/adaptive-retrieval/
  // adaptive-retrieval.service.ts. Never invoked for a query that didn't
  // decompose, and never invoked merely because a direct query's retrieval
  // was weak (see that service's doc comment for the rationale).
  ADAPTIVE_RETRIEVAL: {
    ENABLED: optional('ADAPTIVE_RETRIEVAL_ENABLED', 'true') === 'true',
    // Each iteration produces at most ONE new targeted retrieval query —
    // kept small on purpose; a higher value is supported but must be an
    // explicit operator choice, never the default.
    MAX_ITERATIONS: parseInt(optional('ADAPTIVE_RETRIEVAL_MAX_ITERATIONS', '1'), 10),
  },

  // ── Answer Verification (post-generation output guardrail) ───────
  // Runs after the existing strict grounded generator produces a draft —
  // see rag/guardrails/output/output-guardrail.service.ts. Judges
  // groundedness against the exact evidence generation used, not a second
  // retrieval pass (Iterative Adaptive Retrieval already owns pre-
  // generation evidence gaps). Only reached for LLM-generated grounded
  // answers — never for GREETING's canned reply or a deterministic
  // not-found fallback.
  ANSWER_VERIFICATION: {
    ENABLED: optional('ANSWER_VERIFICATION_ENABLED', 'true') === 'true',
    // At most one bounded revise-then-reverify pass — never an open-ended
    // generate/verify/revise loop. A higher value is supported but must be
    // an explicit operator choice, never the default.
    MAX_REVISIONS: parseInt(optional('ANSWER_VERIFICATION_MAX_REVISIONS', '1'), 10),
    // When the verifier itself could not run (timeout / provider error /
    // unparseable output, even after its one retry) there is no verdict
    // against the draft — only an absence of one. Default true: serve the
    // already-generated, evidence-grounded draft (never cached, still
    // format/PII guarded) instead of replacing it with "not found". Set to
    // false for strict mode (any verifier failure -> conservative fallback).
    FAIL_OPEN_ON_VERIFIER_ERROR: optional('ANSWER_VERIFICATION_FAIL_OPEN', 'true') === 'true',
  },

  // ── Selective Output Format Validation (post-generation output guardrail) ──
  // Runs after groundedness verification/revision, only when the effective
  // user query explicitly asked for a LIST or TABLE — see rag/guardrails/
  // output/format/response-format.detector.ts's deterministic signal
  // groups. Most questions stay NATURAL_TEXT and never reach validation or
  // repair. Independent of ANSWER_VERIFICATION.ENABLED: format safety is a
  // separate concern from hallucination detection.
  OUTPUT_FORMAT_VALIDATION: {
    ENABLED: optional('OUTPUT_FORMAT_VALIDATION_ENABLED', 'true') === 'true',
    // One bounded repair attempt only — never an iterative repair loop.
    REPAIR_ENABLED: optional('OUTPUT_FORMAT_REPAIR_ENABLED', 'true') === 'true',
  },

  // ── Output PII Leakage Detection (post-generation output guardrail) ──────
  // Runs after groundedness verification/revision and after any format
  // repair, on the actual final answer text — see rag/guardrails/output/
  // pii/output-pii-leakage.guard.ts. Shares detection/sanitization rules
  // with the input PII guard via rag/guardrails/shared/pii/ — never a
  // second, drifted implementation.
  OUTPUT_PII_GUARD: {
    ENABLED: optional('OUTPUT_PII_GUARD_ENABLED', 'true') === 'true',
  },
} as const;
