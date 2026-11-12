# Quiz generation latency correction

This patch concerns practice quiz generation, not chat vector search. It leaves
Gemini model selection, project quota, embeddings, indexes, answer memory and
optional database warm-up flags unchanged. No new migration or dependency is
added. The branch's existing archive migrations 024/025 are still required.

## Behavior

- Only an explicit student quiz request starts model work. No page-load or
  next-quiz pre-generation. One concurrent creation per student per process.
- Validate selected course/lectures live and pin active dataset version IDs.
- Fetch at most 14 bounded source excerpts per lecture, after sampling metadata
  in SQL. Prefer named topic diversity within evenly spread lecture segments.
  Null topic metadata still supports positional coverage. This is not a
  guarantee of every topic being tested in every quiz.
- Cache source packs lazily in backend memory, not quizzes or answers. Keys
  include course, lecture, version and sampling policy. Five-minute TTL and
  128-entry LRU cap; restart clears it. Eligibility is checked on every request.
- Parallel per-lecture generation remains capped at 6. Verify across lectures
  in groups of at most 10, two verifier groups concurrently. The common two-
  lecture, ten-question success path uses two generation calls and one verifier
  call, instead of four calls. Fewer calls do not guarantee proportional speed.
- Literal evidence and independent grounded/unambiguous verification remain
  required. Reject malformed checks. Keep approved questions and repair only
  missing allocations, once, with verification of replacements. No partial or
  unverified quiz is saved. Output explanations request one or two sentences.
- Recheck active versions/eligibility before an atomic save. Submitted quiz
  scoring, ownership and hiding answers until submission are unchanged.

## Timeout and cancellation

The Gemini HTTP timer now starts AFTER RPM queue admission. Queue entries are
cancellable and expiring; removed requests leave no phantom future reservation.
An overall quiz-generation deadline covers queue, reads, generation, verification,
repair and acquiring a save connection. Errors cancel pending/sibling model
requests. One bounded overload retry remains; quota, access, network and timeout
errors are not blindly retried. RPM is NOT raised.

The default overall generation budget is 120 seconds, not a promised generation
time. Many lectures can exceed free-tier capacity and fail explicitly; the
service never silently drops a selected lecture. Once COMMIT begins it is allowed
to settle, avoiding a false cancellation for a committed quiz. Save statements
have a 10-second statement timeout. Arbitrary DB/network failures and post-commit
reload are not guaranteed to obey an exact total wall-clock deadline. Cancelling
a DB read wait does not cancel that read internally, but it starts no model call
or quiz write after expiry. Late save-connection checkouts are released.

Safe QUIZ-STAGE / QUIZ-EVIDENCE / QUIZ-LLM / QUIZ-TOTAL logs show request UUID,
phase, cache hit, queue wait and API timing. No keys, student IDs, question text,
source contents or model answers are logged. Error messages distinguish queue,
quota, access, network, response parsing and model timeout/overload.

## Optional backend settings

Defaults require no .env changes:

| Setting | Default | Meaning |
| --- | --- | --- |
| QUIZ_GENERATION_TIMEOUT_MS | 120000 | Overall generation budget |
| GEMINI_QUIZ_QUEUE_TIMEOUT_MS | 65000 | Maximum admission wait |
| QUIZ_EVIDENCE_CACHE_TTL_MS | 300000 | Source-pack TTL |
| QUIZ_EVIDENCE_CACHE_MAX_ENTRIES | 128 | LRU entry limit |

The source cache, student guard and RPM limiter are process-local. A multi-
instance deployment needs shared coordination before claiming global limits.
No Neon RAM pinning, prewarm, new embeddings or paid provider is involved.

## Validation and owner smoke test

`node --test tests/quiz-performance.test.cjs` runs actual TypeScript modules
with injected fake database/model responses. The dedicated workflow additionally
runs real source-selection SQL against disposable local PostgreSQL 17, existing
quiz/provider checks and a full backend typecheck. No real Gemini/Neon is used.
The SQL case skips unless QUIZ_TEST_DATABASE_URL targets localhost database
quiz_latency_test. Regression success is not a live latency/quality measurement.

After pull and backend restart, explicitly create a quiz using the same two
lectures twice within five minutes. The second request should show evidence
cache hits but must still generate a new quiz. Compare QUIZ-TOTAL and per-stage
logs, including queueMs/apiMs; do not claim fixed seconds or percentage savings
until measured with the real provider. Never share API keys or connection URLs.
