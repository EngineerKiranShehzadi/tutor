import { Router, Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { AuthenticatedRequest, QnaChunk } from '../types';
import { AppError } from '../middleware/errorHandler';
import { askLectureAgent } from '../services/chat.service';
import { enforceAskQuota, AskQuotaExceededError } from '../services/ask-quota.service';
import { logger } from '../utils/logger';
import { logSafeText } from '../observability/sanitize';

const router = Router();

const MAX_QUESTION_CHARS = 2000;
const HEARTBEAT_MS = 15000;

// Same shape the GraphQL askLectureAgent mutation returns for sources, so the
// frontend can treat both paths identically.
const chunkToSource = (c: QnaChunk) => ({
  id:        c.id,
  topic:     c.topic ?? null,
  question:  c.question,
  startTime: c.start_time ?? null,
  endTime:   c.end_time   ?? null,
});

// POST /api/v1/chat/ask-stream — Server-Sent Events version of the
// askLectureAgent mutation. Same pipeline, same persistence, same guardrails;
// Keep a live SSE connection, but NEVER expose the unverified generation
// draft: the output guardrail may revise or replace it (including a temporary
// "not found" with a supported answer). Students only see authoritative text.
//
// Events:
//   processing {}      — request accepted; show a loading state, not draft text
//   final  {answer, sources} — authoritative guardrail-settled result
//   error  {message}   — request failed
router.post('/ask-stream', protect, async (req: AuthenticatedRequest, res: Response) => {
  const student = req.user;
  const { lectureId, question, sessionId, tutoringMode } = (req.body ?? {}) as {
    lectureId?: unknown; question?: unknown; sessionId?: unknown; tutoringMode?: unknown;
  };

  if (!student) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }
  if (
    !Number.isInteger(lectureId) || !Number.isInteger(sessionId) ||
    typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS
  ) {
    res.status(400).json({ success: false, message: 'Invalid lectureId, sessionId or question' });
    return;
  }

  // Before the stream opens, so a refusal is a plain 429 the client can show.
  try {
    await enforceAskQuota(student.id);
  } catch (err) {
    if (err instanceof AskQuotaExceededError) {
      res.status(429).set('Retry-After', String(err.retryAfterSec)).json({ success: false, message: err.message });
      return;
    }
    logger.error('[CHAT-STREAM] Quota check failed', err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    return;
  }

  res.status(200).set({
    'Content-Type':      'text/event-stream; charset=utf-8',
    'Cache-Control':     'no-cache, no-transform',
    Connection:          'keep-alive',
    'X-Accel-Buffering': 'no', // stop nginx-style proxies from buffering the stream
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);

  let clientGone = false;

  // Comment lines keep idle connections (slow retrieval / rate-limit
  // backoff) from being dropped by intermediaries.
  const heartbeat = setInterval(() => {
    if (!clientGone && !res.writableEnded) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  // A client that disconnects stops the heartbeat right away, instead of it
  // ticking until the pipeline finishes. (The finally below clears it too;
  // clearInterval is idempotent.)
  res.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) logger.info(`[CHAT-STREAM] client disconnected before the answer — heartbeat stopped (session #${String(sessionId)})`);
  });

  const send = (event: string, data: unknown): void => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  logger.info(`[CHAT-STREAM] "${student.email}" → session #${sessionId}: "${logSafeText(question, 80)}"`);

  // Make the request visible to the client immediately; a disconnect after
  // acceptance must not trigger a duplicate GraphQL question/charge.
  send('processing', {});
  try {
    const { answer, sources } = await askLectureAgent({
      studentId: student.id,
      lectureId: lectureId as number,
      question:  question.trim(),
      sessionId: sessionId as number,
      tutoringMode,
      // Preserve the internal streaming generation path and its PII checks,
      // but never send provisional tokens before verification settles.
      stream: {
        onDelta: () => {},
        onReset: () => {},
      },
    });
    send('final', { answer, sources: sources.map(chunkToSource) });
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Something went wrong. Please try again.';
    if (!(err instanceof AppError)) logger.error('[CHAT-STREAM] Unexpected error', err);
    send('error', { message });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

export default router;
