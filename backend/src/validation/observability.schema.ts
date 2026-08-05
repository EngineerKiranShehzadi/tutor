import { query, param, body } from 'express-validator';

// Validation for /api/v1/observability/* query/route params. Follows the
// existing project convention (express-validator + the shared `validate`
// middleware — see auth.controller.ts / middleware/validate.ts) rather than
// introducing a second validation library.

const ISO_DATE_MSG = 'must be a valid ISO 8601 timestamp';
const isoDate = (field: string) => query(field).optional().isISO8601().withMessage(`${field} ${ISO_DATE_MSG}`).toDate();

const SORT_FIELDS = ['start_time', 'latency_ms'];
const ORDER_VALUES = ['asc', 'desc'];
const STATUS_VALUES = ['SUCCESS', 'ERROR', 'OK', 'UNSET'];
// OpenInference's OpenInferenceSpanKind enum (@arizeai/openinference-semantic-conventions)
// plus 'UNKNOWN', the default normalize.ts assigns when a span carries no
// recognized openinference.span.kind attribute — see services/observability/normalize.ts.
const SPAN_KIND_VALUES = ['LLM', 'CHAIN', 'TOOL', 'RETRIEVER', 'RERANKER', 'EMBEDDING', 'AGENT', 'GUARDRAIL', 'EVALUATOR', 'PROMPT', 'UNKNOWN'];
// Real domain set from aggregate.service.ts's memory-hit/-miss classification.
const MEMORY_RESULT_VALUES = ['EXACT_HIT', 'SEMANTIC_HIT', 'MISS'];

// Rejects a startTime that is after endTime — applied once both are known
// to be valid dates (isISO8601 has already run via the chain above).
const timeRangeOrdered = query('endTime').custom((endTime, { req }) => {
  const startTime = req.query?.startTime as string | undefined;
  if (startTime && endTime && new Date(startTime).getTime() > new Date(endTime).getTime()) {
    throw new Error('startTime must not be after endTime');
  }
  return true;
});

export const overviewValidators = [
  isoDate('startTime'),
  isoDate('endTime'),
  timeRangeOrdered,
  query('lectureId').optional().isString().trim().isLength({ max: 100 }),
  query('sessionId').optional().isString().trim().isLength({ max: 200 }),
  query('route').optional().isString().trim().isLength({ max: 60 }),
  query('status').optional().isIn(STATUS_VALUES),
  query('environment').optional().isString().trim().isLength({ max: 40 }),
];

export const traceListValidators = [
  query('cursor').optional().isString().trim().isLength({ max: 500 }),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  isoDate('startTime'),
  isoDate('endTime'),
  timeRangeOrdered,
  query('search').optional().isString().trim().isLength({ max: 200 }),
  query('traceId').optional().isString().trim().isLength({ max: 200 }),
  query('sessionId').optional().isString().trim().isLength({ max: 200 }),
  query('lectureId').optional().isString().trim().isLength({ max: 100 }),
  query('userId').optional().isString().trim().isLength({ max: 100 }),
  query('route').optional().isString().trim().isLength({ max: 60 }),
  query('status').optional().isIn(STATUS_VALUES),
  query('spanKind').optional().isString().trim().toUpperCase().isIn(SPAN_KIND_VALUES),
  query('spanName').optional().isString().trim().isLength({ max: 100 }),
  query('model').optional().isString().trim().isLength({ max: 100 }),
  query('minLatencyMs').optional().isInt({ min: 0 }).toInt(),
  query('maxLatencyMs').optional().isInt({ min: 0 }).toInt(),
  query('memoryResult').optional().isString().trim().toUpperCase().isIn(MEMORY_RESULT_VALUES),
  query('errorOnly').optional().isBoolean().toBoolean(),
  query('sort').optional().isIn(SORT_FIELDS),
  query('order').optional().isIn(ORDER_VALUES),
];

export const traceIdParamValidators = [
  param('traceId').isString().trim().isLength({ min: 1, max: 200 }).withMessage('traceId is required'),
];

export const spanListValidators = [
  query('cursor').optional().isString().trim().isLength({ max: 500 }),
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  isoDate('startTime'),
  isoDate('endTime'),
  timeRangeOrdered,
  query('traceIds').optional().isString().trim().isLength({ max: 2000 }),
  query('parentId').optional().isString().trim().isLength({ max: 200 }),
  query('name').optional().isString().trim().isLength({ max: 100 }),
  query('spanKind').optional().isString().trim().toUpperCase().isIn(SPAN_KIND_VALUES),
  query('status').optional().isIn(STATUS_VALUES),
  query('minLatencyMs').optional().isInt({ min: 0 }).toInt(),
  query('maxLatencyMs').optional().isInt({ min: 0 }).toInt(),
  query('search').optional().isString().trim().isLength({ max: 200 }),
  query('model').optional().isString().trim().isLength({ max: 100 }),
];

export const spanIdParamValidators = [
  param('spanId').isString().trim().isLength({ min: 1, max: 200 }).withMessage('spanId is required'),
];

export const sessionListValidators = [
  query('cursor').optional().isString().trim().isLength({ max: 500 }),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const sessionIdParamValidators = [
  param('sessionId').isString().trim().isLength({ min: 1, max: 200 }).withMessage('sessionId is required'),
];

export const createNoteValidators = [
  body('note').isString().trim().isLength({ min: 1, max: 2000 }).withMessage('note must be 1-2000 characters'),
];

export const createAnnotationValidators = [
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('name must be 1-100 characters'),
  body('label').optional().isString().trim().isLength({ max: 100 }),
  body('score').optional().isFloat({ min: -1000, max: 1000 }).toFloat(),
];
