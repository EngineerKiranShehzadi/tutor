import { Router, Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { AuthenticatedRequest, QnaChunk } from '../types';
import { AppError } from '../middleware/errorHandler';
import { askLectureAgent } from '../services/chat.service';
import { logger } from '../utils/logger';

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
// the only difference is that the grounded-answer draft is pushed to the
// client as it is generated.
//
// Events:
//   delta  {text}      — next piece of the draft answer
//   reset  {}          — discard the draft so far (generation retried)
//   final  {answer, sources} — authoritative result; replaces any streamed
//                        draft (the output guardrail may have revised it)
//   error  {message}   — request failed
router.post('/ask-stream', protect, async (req: AuthenticatedRequest, res: Response) => {
  const student = req.user;
  const { lectureId, question, sessionId } = (req.body ?? {}) as {
    lectureId?: unknown; question?: unknown; sessionId?: unknown;
  };

  if (!student) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }
  if (
    !Number.isInteger(lectureId) || !Number.isInteger(sessionId) ||
    typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS
  ) {
    res.status(400).json({ success: false, message: 'Invalid lectureId, sessionId or question' });
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
  res.on('close', () => { clientGone = true; });

  const send = (event: string, data: unknown): void => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Comment lines keep idle connections (slow retrieval / rate-limit
  // backoff) from being dropped by intermediaries.
  const heartbeat = setInterval(() => {
    if (!clientGone && !res.writableEnded) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  logger.info(`[CHAT-STREAM] "${student.email}" → session #${sessionId}: "${question.slice(0, 80)}"`);

  try {
    const { answer, sources } = await askLectureAgent({
      studentId: student.id,
      lectureId: lectureId as number,
      question:  question.trim(),
      sessionId: sessionId as number,
      stream: {
        onDelta: text => send('delta', { text }),
        onReset: () => send('reset', {}),
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
