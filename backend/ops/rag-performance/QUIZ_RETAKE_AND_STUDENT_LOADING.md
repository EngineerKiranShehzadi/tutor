# Quiz retakes and student navigation

This supplements QUIZ_LATENCY_FIX.md. Scope: the practice quiz backend and
student UI only. Admin pages, admin Apollo configuration, credentials,
permissions, vector search, embeddings, model selection and warm-up flags are
unchanged. No migration, paid provider or new runtime dependency is required.

## Retake behavior

Retake uses retakePracticeQuiz(id), not a second createPracticeQuiz call with a
client-provided lecture list. The backend reads the owned COMPLETED attempt and
derives exactly its course and lectures. It never updates that attempt or score.
Prior questions are excluded in the generation prompt, normalized exact/obvious
lexical duplicates are removed before verification, and the existing independent
verifier also requires distinctFromPrevious. No extra novelty-only model request
is added. Missing, malformed or negative novelty checks fail closed. One bounded
repair remains; insufficient novel grounded material returns a clear failure,
not repeated questions, a partial quiz or invented facts.

Novelty is against the immediate quiz being retaken, not every question ever
seen. Lexical and model semantic checks are safeguards, not a mathematical
proof of semantic uniqueness. The live Gemini behavior still needs an owner
smoke check; fixture tests do not establish educational quality.

## Source rotation and round trips

The version/course/lecture-scoped five-minute, 128-entry in-memory cache now
holds up to 56 source excerpts per lecture. All cache misses for one request are
loaded in a single parameterized query using paired lecture/version arrays.
Each explicit request selects at most 14 excerpts, keeping the 6,000-character
content budget. Retakes prefer previously unused chunks when enough exist;
short lectures may reuse a source for genuinely different facts. Topic and
positional spread are heuristics, not complete topic coverage.

This fetches a wider bounded pool on a cold miss; it is not claimed to make
every cold read faster. Warm requests reuse it while rotating the selection.
No quizzes, answers or student content are put in the shared source cache.
INSERT RETURNING supplies creation responses, saving two post-commit SELECTs.
The same response formatter keeps correct answers hidden until submission.

## Student-only navigation

Authenticated students get a separate Apollo cache per mounted account. The
existing transport is reused, not the admin or previous account's cached data.
Only course/lecture metadata is fetched on student layout entry. Hover, keyboard
focus and touch intent prefetch allowlisted route code and read-only destination
data. There is a bounded 30-second prefetch gate and in-flight deduplication.
No chat session, quiz, LLM request, vector search or pg_prewarm is triggered by
these prefetches. Activity/history reads happen on destination intent, not all
at login. Returning to an active tab refreshes eligible metadata reads.

Courses, lectures, practice selectors/history and activity retain cached data
while refreshing. Failed requests are not shown as empty successful results.
A first uncached visit still waits for authentication/network/server work;
route skeletons are feedback, not measured latency reduction. Development-mode
Next.js compilation and external video/model loading are separate costs.
Course/lecture cards are real links, allowing route and data intent prefetch.
The lecture query parameter stays in sync during same-page navigation.

Quiz submission returns full results so the UI displays the score without
waiting for duplicate quiz/progress reads. History refresh is non-blocking;
activity progress is invalidated. Retake replaces the active ID only after a
successful new quiz; failure leaves the prior result visible. Generation stays
explicit-click only. Existing quizzes can be read-prefetched from history.

## Validation

Dedicated CI runs actual service modules with fake model/database adapters,
real PostgreSQL 17 sampling/ownership SQL in a disposable database, the existing
quiz/provider checks and both full TypeScript checks. Frontend tests exercise
actual Apollo cache behavior, helper gates and React server-rendered cached
course cards. These are not full live browser, real Neon or Gemini tests.

After pulling, restart backend AND frontend. Check the same completed quiz's
Retake button: selected lectures must stay identical, previous score must stay
intact, and new questions should not repeat the previous quiz. For navigation,
compare an uncached visit and a return visit to Courses/Lectures/Practice/My
Activity. Read QUIZ-TOTAL and QUIZ-LLM for model/queue timing. No fixed-second or
percentage speed claim should be made without real before/after measurements.
