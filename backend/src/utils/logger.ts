import winston from 'winston';
import { env } from '../config/env';
import { getActiveTraceId } from '../observability/trace-context';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Stamps every record logged inside an active request trace with its trace ID
// (same ID as the [TRACE] line and Phoenix). No-op outside a trace.
const withTraceId = winston.format((info) => {
  const traceId = getActiveTraceId();
  if (traceId) info.traceId = traceId;
  return info;
});

const devFormat = combine(
  withTraceId(),
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, traceId }) => {
    const tag = traceId ? ` [trace=${String(traceId).slice(0, 8)}]` : '';
    return stack
      ? `${timestamp} [${level}]${tag}: ${message}\n${stack}`
      : `${timestamp} [${level}]${tag}: ${message}`;
  })
);

const prodFormat = combine(
  withTraceId(),
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

const isProd = env.NODE_ENV === 'production';

// File logging is opt-in (LOG_TO_FILE=true); in production the default is
// console-only JSON for the platform's log collector. Size-based rotation
// uses winston's built-in File options.
const fileOptions = { maxsize: 10 * 1024 * 1024, maxFiles: 5 };

export const logger = winston.createLogger({
  level: isProd ? 'info' : 'debug',
  format: isProd ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    ...(isProd && env.LOG_TO_FILE
      ? [new winston.transports.File({ filename: 'logs/error.log', level: 'error', ...fileOptions }),
         new winston.transports.File({ filename: 'logs/combined.log', ...fileOptions })]
      : []),
  ],
});
