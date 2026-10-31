# Change Log — AskAITutor

This file records every change made to the code after the FYP-1 evaluation,
with the reason and the standard it follows.

Newest entry at the top.

---

## 2026-10-31 — Admin/dataset fixes, batch 3: honest preview, upload status race, CSV injection, migrations, PII paging, GraphQL limits, CSP, indexed purge (A7–A14)

**Changed by:** Kiran
**Files:** `backend/src/services/{chunk,dataset-version,analytics}.service.ts`,
`backend/src/controllers/dataset.controller.ts`, `backend/src/graphql/{index,typeDefs,query-limits}.ts`
(query-limits new), `backend/src/graphql/resolvers/analytics.resolver.ts`, `backend/src/config/env.ts`,
`backend/src/scripts/db-setup.ts`, `backend/src/db/migrate.sql`,
`backend/src/db/migrations/014_source_chunk_ids_gin.sql` (new), `backend/package.json`, `backend/.env.example`,
`frontend/next.config.mjs`, `frontend/src/lib/csv.ts` (new), `frontend/src/lib/api.ts`,
`frontend/src/components/admin/DatasetManager.tsx`, `frontend/src/graphql/analytics.queries.ts`,
`frontend/src/app/(admin)/admin/{questions,users,students,dashboard}/page.tsx`, tests in `backend/src/scripts/`

**Deploy note:** run `npm run db:setup` (or `db:migrate`, now the same thing) to
apply migration `014`. The first run on an existing database creates the
`schema_migrations` ledger and re-applies every numbered migration once; they are
all idempotent. After that, files that are already applied are skipped.

- **A7 — the preview under-reported.**
  - Rows with an empty question or answer are now listed in the preview, with
    their real spreadsheet row; blank rows in between no longer shift the
    numbers.
  - Answers cut to 20 pieces are listed too: row, question, how many pieces,
    how many kept.
  - `rowsInFile` is the sheet's data-row count, and `rowsUsed` is what became
    Q&As. The dataset manager shows both warnings and "N rows in file · M used".
- **A8 — a lecture could be stuck at DATASET_UPLOADED with a live dataset.**
  - The upload no longer changes the lecture status outside the build
    transaction. `buildVersion` already sets a first-ever lecture to EMBEDDING
    inside its transaction, under the lecture lock, so a refused build changes
    nothing. The old status-restore code is gone.
  - `reconcileLectureStatuses()` runs at startup and in the periodic sweep. It
    sets any lecture that has a live version but a stale status back to READY.
  - The admin lecture list reports `STATUS_NOT_READY: …` instead of a blank
    reason.
- **A9 — CSV formula injection.** New shared `frontend/src/lib/csv.ts`. Every
  cell is quoted with quotes doubled. Cells starting with `= + - @`, tab or CR
  get a leading apostrophe. Files have a UTF-8 BOM so Excel shows non-ASCII
  names correctly. The users, students and questions exports all use it.
- **A10 — migrations.**
  - `npm run db:migrate` now runs the full setup sequence instead of only
    `schema.sql`.
  - Numbered migrations are recorded in a `schema_migrations` ledger (file name
    and checksum). Each file and its ledger row commit together.
  - The "Previous Chats" backfill in `migrate.sql` no longer adds a session per
    re-run, and removes empty duplicates that earlier re-runs left.
- **A11 — 10,000 student-question rows with PII in one query.**
  - `recentQuestions(limit)` now honours `limit`: default 10, at most 100.
  - New `recentQuestionsPage(limit, offset, search, lectureId)`: at most 200
    rows per page, with `total` and `hasMore`. Search matches `%` and `_`
    literally.
  - The Student Questions page pages, searches and filters on the server. Its
    export fetches the matching rows 200 at a time.
  - The dashboard asks for 10.
- **A12 — GraphQL.** Introspection is off in production (`GRAPHQL_INTROSPECTION`
  overrides). A validation rule rejects operations deeper than
  `GRAPHQL_MAX_DEPTH` (10) or selecting more than `GRAPHQL_MAX_FIELDS` (200)
  fields, and fragments are expanded when counting. The app's deepest query is
  3 levels and its largest 22 fields.
- **A13 — no CSP.** `next.config.mjs` sends a Content-Security-Policy:
  - Allowed: `self`, the API origin, cdnjs (FontAwesome), YouTube iframes,
    `i.ytimg.com` and `lh3.googleusercontent.com` images, and `blob:`/`data:`
    where the app needs them.
  - Blocked: plugins (`object-src 'none'`), framing (`frame-ancestors 'none'`),
    and anything outside `base-uri` and `form-action`.
  - `'unsafe-inline'` scripts are still needed by Next's inline bootstrap
    scripts; `'unsafe-eval'` and the websocket are allowed in development only.
- **A14 — unindexed purge checks.** Migration `014` adds GIN indexes on
  `chat_history.source_chunk_ids` and `rag_answer_memory.source_chunk_ids`. The
  purge asks `source_chunk_ids @> ARRAY[id]`, which can use them;
  `id = ANY(...)` cannot.
- **Tests:**
  - test-dataset-pipeline: new 26a–d (preview counts with a blank-row gap, the
    two-admin upload race, the status repair, the purge using the GIN indexes);
    21g updated for A8.
  - test-admin-hardening: new A9-2, A10-1..3, A11-2, A12-1..2. A12 checks all
    39 frontend operations against the real schema and the limits.
  - Browser check (Playwright, dev server): about 15 student and admin pages
    with zero CSP violations. FontAwesome, YouTube and API calls work. The
    users and questions exports neutralise a `=HYPERLINK(…)` name. Questions
    paging and search run on the server. The upload preview shows skipped and
    truncated rows.

---

## 2026-10-31 — Admin/dataset fixes, batch 2: stuck builds, upload limits, question limits, readiness (A2, A4, A5, A6)

**Changed by:** Kiran
**Files:** `backend/src/services/dataset-version.service.ts`, `backend/src/services/chunk.service.ts`,
`backend/src/services/dataset-plan.ts`, `backend/src/utils/xlsx-guard.ts` (new),
`backend/src/services/ask-quota.service.ts` (new), `backend/src/observability/provider-signal.ts` (new),
`backend/src/observability/health.service.ts`, `backend/src/embedding/*`, `backend/src/rerank/providers/voyage-rerank.provider.ts`,
`backend/src/app.ts`, `backend/src/config/env.ts`, `backend/src/routes/{dataset,chat,index}.routes.ts`,
`backend/src/controllers/dataset.controller.ts`, `backend/src/graphql/resolvers/chat.resolver.ts`,
`backend/src/db/migrations/013_dataset_outage_and_ask_quota.sql` (new), `backend/.env.example`,
`frontend/src/components/admin/DatasetManager.tsx`, `frontend/src/lib/{api,chat-stream}.ts`,
`frontend/src/hooks/useChat.ts`, `docs/OBSERVABILITY.md`, tests in `backend/src/scripts/`

**Deploy note:** apply migration `013` (`npm run db:setup`, or run the file) before
starting this code. It adds `dataset_versions.outage_since` and an index on
`student_questions (student_id, created_at)`.

- **A2 — a stuck build blocked the lecture forever.** A 429 counted as a passing
  outage, so a used-up quota retried every 15 s for ever. Meanwhile every upload
  got 409 and rollback was refused, and only database surgery could end it. Now:
  - OpenAI's 429 `insufficient_quota` is `EmbeddingQuotaExceededError`. The
    build fails on the first pass with "quota exhausted — raise the quota or
    billing limit, then upload the file again".
  - A plain 429 is `EmbeddingRateLimitedError`. It waits like an outage and the
    note says "rate-limiting (429)".
  - Waiting on an outage or rate limit is capped. After
    `DATASET_OUTAGE_MAX_MINUTES` (default 360) without progress the build fails.
    Any pass that embeds something restarts the clock.
  - New admin action **Cancel update**: `POST /api/v1/datasets/cancel/:lectureId`,
    with a button and confirmation in the dataset manager. It marks the
    in-flight version FAILED through the batch-1 guarded path, so the live
    dataset is never touched. A running embedding loop sees this within about
    2 s and stops. Upload and rollback work again right away.
  - Voyage reports 429 as "rate limit or quota exceeded", separate from 5xx.
- **A4 — unbounded parsing of uploads on the shared thread.** Before
  SheetJS sees the file:
  - The zip is checked: declared sizes, entry count, and real inflation with a
    hard output cap, so a zip that lies about its size is caught too.
  - Only the dataset sheet is parsed, stopping one row past the limit.
  - Only the first `DATASET_MAX_COLUMNS` columns are read.
  - Limits: `DATASET_MAX_ROWS` 5000, `DATASET_MAX_UNCOMPRESSED_MB` 50,
    `DATASET_MAX_ZIP_ENTRIES` 500, `DATASET_MAX_COLUMNS` 100. The real merged
    lecture files have at most 545 rows and are under 1 MB uncompressed.
  - Breaking a limit, or a file that isn't a zip, returns a clear 400.
  - The possible-duplicate scan (it runs on every preview) was all-pairs. It
    now uses hash maps plus the standard Jaccard prefix filter, with exactly the
    same result: 5,000 × 5,000 rows in about 0.2 s.
- **A5 — no limit on the LLM path, and every user shared one IP.** Express
  `trust proxy` is now set from `TRUST_PROXY` (default 1 hop in production,
  off otherwise), so `req.ip` is the client. Asking the tutor is now limited
  per student on both GraphQL `askLectureAgent` and `/chat/ask-stream`:
  - `CHAT_RATE_LIMIT_PER_MINUTE` (default 10), kept in memory per process.
  - `CHAT_DAILY_QUESTION_LIMIT` (default 200), counted in `student_questions`,
    so it holds across restarts and instances.
  - Over the limit, GraphQL returns `RATE_LIMITED` and the stream returns HTTP
    429 with `Retry-After` before it opens. The chat shows the message instead
    of the generic "trouble connecting" reply.
- **A6 — readiness reported a dead answer path as healthy.** `/health/ready`
  now requires every component a question needs: database, pgvector,
  embedding, reranker (a rerank failure fails the question), and Gemini when it
  is the answer model. Any of them down gives 503. `degraded` (200) now only
  means a check that verified configuration only. Hosted providers are still
  never checked with a paid call. OpenAI embeddings are probed with a free
  `GET /v1/models/{model}`. Voyage is judged from recent real calls: two
  availability failures in a row within 5 minutes means unhealthy.
- **Tests:**
  - test-dataset-pipeline (78/78), new 25a–f: quota fails fast, the rate-limit
    cap, progress restarts the clock, cancel mid-build, cancel with nothing in
    flight, cancel a first build.
  - New test-admin-hardening (16/16): zip bomb, lying zip, entries, rows,
    columns, the 7 real datasets unchanged, the duplicate scan equal to the old
    scan on 400 random cases, trust proxy, burst and daily limits on both entry
    points, readiness rules.
  - test-hosted-providers (35/35): OpenAI probe, quota vs rate limit.

---

## 2026-10-31 — Admin/dataset fixes, batch 1: the live dataset can't be destroyed or replaced by a stale-model one (A1, A3)

**Changed by:** Kiran
**Files:** `backend/src/services/dataset-version.service.ts`,
`backend/src/scripts/retry-missing-embeddings.ts`,
`backend/src/scripts/test-dataset-pipeline.ts`

- **A1 — a failed or raced activation could wipe the live dataset.** If a
  version's activation reported an error after the switch had actually happened
  (another API instance or `seed:retry` got there first, or the COMMIT reply was
  lost), the version now being served was marked FAILED and then emptied by
  cleanup. The lecture still said READY, but every question got
  EMPTY_ACTIVE_VERSION. Now:
  - Marking a version FAILED locks it and the lecture and only applies to a
    version that is still being built (BUILDING / READY_TO_ACTIVATE) and is not
    the lecture's active one. Otherwise it does nothing and returns SKIPPED.
  - Activation that finds the version no longer READY_TO_ACTIVATE returns
    SKIPPED instead of throwing into the failure path.
  - Cleanup chooses and purges old versions in one transaction under the
    lecture lock, never picks the lecture's active version, and the purge SQL
    also refuses any version that a lecture points at.
  - `seed:retry` exits 0 when the version it tried to finish is live, even if
    another process published it.
  - `failDatasetVersion(id, message)` is exported for the admin cancel action
    (batch 2).
- **A3 — a version made with an old embedding model could go live.**
  Validation compared each chunk's model with the version's own stamp. Chat
  compares it with the live model. A version built entirely under a previous
  model passed validation, went ACTIVE, and every question was then refused as
  STALE_EMBEDDING_MODEL. Validation now checks against the live
  `EMBEDDING_MODEL_VERSION`. This covers new builds and rollback. A version
  resumed at READY_TO_ACTIVATE is now validated again before the switch, where
  it used to skip validation. The activation transaction itself repeats the
  model/vector check under the lock.
- **Tests (test-dataset-pipeline, 73/73 on a fresh PG17 DB):** 23a losing an
  activation race leaves the version ACTIVE and intact; 23b failing the live
  version is a no-op; 23c cleanup never purges the active version even if its
  row says FAILED; 23d two OS processes finish one version at once (one
  ACTIVATED, one SKIPPED); 24a–c an old-model version is rejected by
  validation, rollback and resume. Against the previous code 23a/23b reproduce
  the reported data loss and 24a–c fail.

---

## 2026-10-31 — Compound question with one part down: answer the rest, say that part couldn't be retrieved

**Changed by:** Kiran
**Files:** `backend/src/services/chat.service.ts`,
`backend/src/services/llm-gemini.service.ts`,
`backend/src/rag/guardrails/output/output-guardrail.service.ts`,
`backend/src/rag/query-processing/retrieval/decomposed-retrieval.service.ts`,
tests in `backend/src/scripts/`

Follow-up to D3. When some parts of a compound question found evidence but one
part's lookup failed (embed/search/rerank outage), that part used to be passed on as
"not covered", so the answer said it was not in the lecture. Now it is kept on a
separate "unavailable" list:

- The generator gets its own note for it: don't answer it, don't call it missing
  from the lecture; say it could not be retrieved right now and to ask again.
  The other parts are answered as before.
- The verifier and the revision step treat it as a part that must not be answered.
- If the draft is rejected, the fallback says "I also couldn't retrieve part of
  this right now (…) — please ask again in a moment" instead of "not found".
- Such an answer is never written to answer memory, since it is transient.
- Traces get `query.decomposition.unavailable_subqueries` and
  `unavailableAspectCount`.

The answer prompt is unchanged when nothing failed, so `ANSWER_PROMPT_VERSION`
stays `v2`.

---

## 2026-10-31 — Student RAG fixes, batch 3: streamed PII, compound-question budget, PII and retrieval (D4, D6, D9)

**Changed by:** Kiran
**Files:** `backend/src/services/chat.service.ts`,
`backend/src/rag/guardrails/output/pii/streaming-pii-redactor.ts` (new),
`backend/src/rag/guardrails/input/input-guardrail.service.ts`,
`backend/src/rag/guardrails/input/types/input-guardrail.types.ts`,
`backend/src/rag/query-processing/retrieval/decomposed-retrieval.service.ts`,
`backend/src/rag/query-processing/adaptive-retrieval/adaptive-retrieval.service.ts`,
`backend/src/config/env.ts`, `backend/.env.example`, tests in `backend/src/scripts/`

- **D4 — PII was shown before it was removed.** The draft streamed to the
  browser unredacted; only the final answer was cleaned. Now each streamed piece
  goes through the same PII detector first. The only text held back is the
  trailing run that could still turn into an email, phone, card, ID or IP number
  (so the last word or number appears one piece later); everything sent is
  already redacted. Groundedness and format are still settled by the final
  answer, which replaces the draft, as before. Runs when `OUTPUT_PII_GUARD_ENABLED`
  is on (the default).
- **D6 — compound questions got the same 5 chunks as a one-line question.** A
  decomposed question now gets 4 chunks per sub-question, capped at 12 (never
  fewer than 5): 2 parts → 8, 3 parts → 12. Adaptive retrieval uses the same
  budget. Configurable with `QUERY_DECOMPOSITION_CONTEXT_PER_SUBQUERY` and
  `QUERY_DECOMPOSITION_CONTEXT_MAX_CHUNKS`. Selection logic is unchanged.
- **D9 — PII masking ran before retrieval.** A question with, say, an IP address
  was searched as "[IP_ADDRESS]". The input guardrail now also returns the text
  before masking (`retrievalInput`), and the direct path uses it only to embed,
  vector-search and rerank. Everything stored (student_questions, chat_history,
  answer memory and its embedding), logged, traced or sent to an LLM still uses
  the masked text. Decomposed sub-questions and follow-up rewrites are produced
  by an LLM from the masked text, so they stay masked.

---

## 2026-10-31 — Student RAG fixes, batch 2: outages handled the same way on both paths (D3, D5)

**Changed by:** Kiran
**Files:** `backend/src/services/chat.service.ts`,
`backend/src/rag/query-processing/retrieval/decomposed-retrieval.service.ts`,
`backend/src/embedding/providers/local-http-embedding.provider.ts`,
`backend/src/rerank/providers/local-http-rerank.provider.ts`,
tests in `backend/src/scripts/`

- **D3 — one outage, two answers.** When the embedder, vector search or reranker
  failed, a normal question got an error but a compound (decomposed) question got
  "I could not find this information in this lecture." — and its trace said
  `ALL_CANDIDATES_BELOW_RERANK_FLOOR`. Now each failed sub-question records which
  step failed. If nothing was found and any lookup failed, the request ends in the
  same error as a normal question, with the same trace reason
  (`EMBEDDING_FAILURE` / `VECTOR_SEARCH_FAILURE` / `RERANKER_FAILURE`). "Not found"
  is returned only when every lookup ran and found nothing, and its trace reason is
  now the one observed (`NO_VECTOR_CANDIDATES` or
  `ALL_CANDIDATES_BELOW_RERANK_FLOOR`).
- **D5 — local embedding/rerank adapters (the default).** They now use the same
  retry helper as the hosted adapters (2 quick retries on 429/5xx or no
  connection), so a 503 while the local model loads no longer fails the question.
  They also check replies the way the hosted adapters do: every vector must be
  1024 finite numbers (the single-question `embed()` was not checked before);
  every rerank result must name a known candidate once, with a numeric score;
  rerank scores are sorted best-first before being returned.

---

## 2026-10-31 — Student RAG fixes, batch 1: timeout, fail-closed verifier, prompt (D1, D2, D7, D8)

**Changed by:** Kiran
**Files:** `backend/src/config/env.ts`, `backend/.env.example`,
`backend/src/services/llm-gemini.service.ts`,
`backend/src/rag/guardrails/output/output-guardrail.service.ts`,
`backend/src/rag/guardrails/output/answer-groundedness.prompt.ts`,
tests in `backend/src/scripts/` (new `test-rag-defects.ts`)

- **D1 — answer call had no timeout.** The grounded-answer call was the only LLM
  call with no deadline; on the streaming path the heartbeat kept a stuck call
  open forever. New `RAG_ANSWER_TIMEOUT_MS` (default 45 s, the largest LLM
  budget) is sent with every attempt, streaming or not. A timeout is not retried.
- **D2 — verifier failed open.** `ANSWER_VERIFICATION_FAIL_OPEN` now defaults to
  `false`: if the verifier cannot run, the student gets "I could not find this
  information in this lecture." instead of the unchecked draft, and that draft is
  never saved to chat history. Setting it to `true` is still possible, as an
  explicit choice.
- **D7 — one course name for every lecture.** The system prompt no longer names
  "Master Prompt Engineering with ChatGPT"; the lecture title line and the agent
  block already identify the lecture. `ANSWER_PROMPT_VERSION` is now `v2`, so
  answers cached under the old prompt are no longer served.
- **D8 — retrieved text was not marked as data.** The generator, verifier and
  revision prompts now say that text inside `[Lecture Content]` / `[Evidence N]`
  (and the draft, for the verifier) is reference data and that instructions in
  it are never followed.

Thresholds (0.55 / 0.5) are unchanged.

---

## 2026-10-31 — Laiba's two changes are accepted (supersedes the 2026-10-29 reversals)

**Changed by:** Kiran
**Files:** `backend/src/services/auth.service.ts`,
`backend/src/services/email.service.ts`,
`frontend/src/app/(auth)/signup/page.tsx`,
`frontend/src/components/auth/ForgotPasswordFlow.tsx`

After the full auth-hardening review, **all changes from Laiba's side are accepted.**
The two reversals recorded on 2026-10-29 are themselves reverted — both of Laiba's
original decisions are restored and now stand.

### OTP expiry: 5 minutes — accepted

Laiba's change is kept: codes expire after 5 minutes (NIST SP 800-63B allows up to
10), in both signup and password reset, with the 6-digit length. The resend
cooldown stays 60 seconds. The email text and the Forgot Password screen say
5 minutes to match.

### After signup, the user is logged in — accepted

Laiba's change is kept: after the code is verified the user is signed straight in
and sent to `/courses` (or `/admin/dashboard` for an admin). The signup page stores
the access token in memory and calls `setUser` — no second trip through `/login`.

---

## 2026-10-29 — User Management could not manage admins

**Changed by:** Laiba
**File:** `frontend/src/app/(admin)/admin/users/page.tsx`

### What was wrong

The page filtered the list down to students only:

```js
.filter(u => u.role === 'STUDENT')
```

The server was returning everyone; the screen threw the admins away. The result
was a one-way door:

- You could promote a student to admin
- The moment you did, they disappeared from the list
- You could never demote them, delete them, or even see how many admins existed

For a role that can read every student's questions, upload datasets and delete
accounts, being unable to see or remove it is a real gap.

A second problem on the same page: the action buttons were `opacity-0` until
the row was hovered, so the Actions column looked empty and the buttons
appeared to be missing entirely.

### What was changed

- **All users are shown**, not just students
- **Role column** with a badge, so each person's role is visible at a glance
- **Filter tabs** — All / Students / Admins, each with a count
- **The action adapts to the row** — "Promote" on a student, "Demote" on an admin
- **Your own row is marked YOU** and shows "Your account" instead of buttons,
  because the server refuses both actions on yourself and offering a button
  that can only fail is worse than not offering it
- **Buttons are visible by default** (dimmed, brightening on hover) instead of
  invisible until hovered
- **Promotion now warns** what an admin can do before you confirm
- **Deletion now warns** that the person's questions and chat history go with them
- **Role added to the CSV export**
- **The heading counts correctly** — it used to say "N students registered"
  while counting a list it had already filtered
- **Page number is clamped** — deleting the only row on the last page, or
  narrowing the filter, used to leave the table showing an empty page

### No backend change was needed

The server rules were already correct and were checked:

- `deleteUser` refuses to delete the account making the request
- `updateUserRole` refuses to demote the account making the request

Those two together mean the system can never be left with zero admins, which is
the rule that matters most. The screen now matches what the server already
enforced.

---

## 2026-10-29 — Gmail addresses with dots could never log in

**Changed by:** Laiba
**Files:** `backend/src/controllers/auth.controller.ts`,
`backend/src/services/auth.service.ts`

### What was wrong

Gmail ignores dots, so `ali.khan@gmail.com` and `alikhan@gmail.com` reach the
same inbox. The login route knew this and removed the dots before searching
for the user. Signup did not — it goes through GraphQL, not those validators,
and stored the address exactly as typed.

The two disagreed:

| | Address used |
|---|---|
| Stored at signup | `kiran.shehzadi.basharat.ali@gmail.com` |
| Searched at login | `kiranshehzadibasharatali@gmail.com` |
| Result | no match → **"Invalid email or password"** |

Any account with a dot in its Gmail address was permanently locked out, and a
password reset could not help, because reset stores the dotted form too. This
affected Kiran's account directly. It was hidden until now because the
fake-login shortcut meant the real login code never ran.

The stripping came from `normalizeEmail()`, whose defaults are
`gmail_remove_dots: true` and `gmail_remove_subaddress: true`.

### What was changed

- Removed `normalizeEmail()` from all three validator sets (register, login,
  resend-login-OTP). Addresses are now stored and looked up exactly as typed.
- Fixed a second, hidden bug this exposed: in `registerUser`, the "is this
  email already taken?" check used the raw address while the insert used a
  lowercased one. Every other lookup in that file lowercases. It only worked
  before because `normalizeEmail()` happened to lowercase upstream — removing
  it would have broken the duplicate check and produced a raw database error
  instead of a clear message.

### Which standard

RFC 5321, section 2.4: the part before the `@` is to be interpreted **only by
the receiving mail provider**. An application should not rewrite it. Those
rules belong to Google, apply only to Gmail, and can change.

Lowercasing is kept — it is safe and standard, because providers treat
addresses case-insensitively — and it already happens in the service layer.

### Considered and rejected

Normalising **everywhere**, including signup, would also have been consistent
and would stop one person creating several accounts for one inbox. Rejected
because: every address already in the database is stored with its dots and
would need rewriting; the rules only work for Gmail; and silently storing a
different address from the one a person typed is surprising.

---

## 2026-10-29 — Signup had no checks on the server

**Changed by:** Laiba
**File:** `backend/src/services/auth.service.ts`

### What was wrong

The signup form checks the name, email and password **in the browser**. Those
checks work and are not changing.

But browser checks only protect people using the form. They do nothing against
a request sent directly to the server, which takes seconds with a free tool.

Proper server-side rules do exist, in `auth.controller.ts` — but they are
attached to the REST `/register` route, and the frontend does not use that
route. Signup goes through GraphQL to `signupUser`, which went straight from
"is this email taken?" to saving the account.

**Result:** an account could be created with the password `1`.

Sign-in was not affected — it goes through the REST route and is re-checked on
the server already.

### What was changed

A `validateSignupInput` check added to `signupUser`, running before any
database work. The rules mirror the browser rules exactly, so nothing changes
for a normal user:

| Field | Rule |
|---|---|
| Name | 2–100 characters |
| Email | valid format, max 255 characters |
| Password | 8 or more characters, one capital, one number |
| Password | maximum 72 bytes |

### Why the 72-byte password limit

The hashing library (bcrypt) only looks at the first 72 bytes of a password and
silently ignores the rest. A 100-character password was therefore not fully
protected, and nobody was told. It is now rejected with a clear message instead
of being accepted misleadingly.

### Why the length caps match the database

`name` is `VARCHAR(100)` and `email` is `VARCHAR(255)`. Longer values used to
reach the database and fail there, producing a raw database error instead of a
readable message.

---

## 2026-10-29 — Signing up sent you to the login form

**Changed by:** Laiba
**File:** `frontend/src/app/(auth)/signup/page.tsx`

### What was wrong

After entering the verification code, a brand-new student was sent to the
**login form** and had to type their email and password again, even though they
had just been logged in successfully.

### Why

The app keeps a record of who is signed in, held in memory while you browse
(`AuthProvider`). It is filled in once when the page first loads.

The login page saves the token **and** updates that record. The signup page
saved the token but never updated the record. So moving to `/courses` hit the
guard in `(dashboard)/layout.tsx`, which saw no signed-in user and redirected
to `/login`.

The token was correct the whole time — the app simply did not know it.

### What was changed

One line added after the token is saved:

```ts
setUser(result.user);
```

The verification step already returns the user's details; they were just not
being used. This is exactly what the login page already does.

### Flow before and after

| Before | After |
|---|---|
| Sign up → verify code → **login form → sign in again** → courses | Sign up → verify code → courses |

Logging in later is unaffected.

---

## 2026-10-29 — Repair script was pointing at the wrong column

**Changed by:** Laiba
**File:** `backend/src/scripts/retry-missing-embeddings.ts`

### How it was found

During the Lecture 1 upload, the backend process was killed by the machine at
row 311 of 317. The upload runs as one long task, so it died with the process
and the lecture was left stuck on "Embedding".

The repair script exists for exactly this situation, so it was read before
being used. It was broken.

### What was wrong

| Problem | Effect |
|---|---|
| Looked for missing rows in the `embedding` column | That is the old Gemini column (3,072 numbers). It is empty for every row, so the script matched **all** rows, not the missing ones. |
| Saved results into the same wrong column | It produces 1,024 numbers. Saving those into a 3,072 column fails. **Every row would have failed.** |
| Marked the lecture READY regardless of failures | A run where nothing worked still reported success, leaving a lecture that looks ready and answers nothing. |
| Defaulted to lecture 1 when no id was given | Silently operates on the wrong lecture. |

The script was left over from before the switch to the local embedding model
and was never updated.

### What was changed

- Reads and writes `local_embedding` (1,024 numbers) — the column search
  actually uses — with the same `::vector` cast the upload path uses
- Only marks the lecture READY when **every** row succeeded; otherwise it
  reports how many are still missing and exits with an error
- The lecture id is now required: `npm run seed:retry -- <lectureId>`
- Removed the 400ms pause between rows. It existed for a remote API rate
  limit that no longer applies; on a full re-run it added ~17 minutes for
  nothing.

### Note for both of us

A dataset upload is a single long task tied to the backend process. If the
backend stops for any reason, the upload stops with it and cannot resume on its
own. Use this script to finish the remaining rows rather than re-uploading the
whole file.

---

## 2026-10-29 — What goes into the search (dataset columns)

**Changed by:** Laiba
**File:** `backend/src/services/chunk.service.ts`

### What was wrong

Before a row can be searched, the system joins it into one block of text and
converts that text into numbers that represent its meaning. Three problems:

1. The first line of that block said `Topic: Claude Opus 5` — the name of the
   AI that wrote the answer. It was in every row and has nothing to do with the
   lecture, so every row carried meaning that did not belong to it.
2. The `Source Reference` column (e.g. `Transcript — 00:14`, `Title slide`) was
   read by nothing and thrown away on upload.
3. Timestamps were being mixed into the text that becomes numbers, even though
   a timestamp says nothing about what the lecture is about.

### What was changed

| Column in the Excel file | Went to (before) | Goes to (now) |
|---|---|---|
| `Model Name` | `topic` — wrong | `llm_name` — the column made for it |
| `Source Reference` | nowhere | `start_time` — shown next to the answer |

Also:
- The `Topic:` line is now written only when a real topic exists.
- Timestamps are stored and displayed, but kept out of the text that becomes
  numbers.
- A `topic` column is no longer required for upload (the merged datasets do not
  have one).

The older three-column file (`Model Name` / `Questions` / `Answers`) still
uploads correctly — it just stores the model name in the right place now.

### Why

The numbers that represent a row's meaning should describe the lecture, not the
paperwork around it. Values that repeat across every row add nothing that helps
tell rows apart, and take up room in a text that has a size limit.

### Effect, checked against the real files

All seven merged datasets were run through the new logic before this was
applied:

- 2,826 rows total, **0 skipped**
- **2,826 rows have a Source Reference**, so every answer can show where it came from
- Only 2 rows (both in Lecture 3) are long enough to be split

---

## 2026-10-25 — Verification code (OTP): length and expiry

**Changed by:** Laiba
**Branch:** `feature/ui-profile-design-system`

### What was wrong

| | Before | Problem |
|---|---|---|
| Code length | **5 digits** | Below the security standard, which requires at least 6 |
| Code expiry | **60 seconds** | Too short to actually use. The user opens their email, and the code has already died. |

The 60-second expiry was not a security mistake — it is well inside the allowed
limit. It was a usability problem. In testing, it made signup fail repeatedly:
the account gets created, the code expires, and signing up again is refused
because the email now exists.

### What was changed

| File | Change |
|---|---|
| `backend/src/services/auth.service.ts` | Code is now 6 digits instead of 5 (2 places) |
| `backend/src/services/auth.service.ts` | Expiry is now 5 minutes instead of 60 seconds (2 places) |
| `backend/src/services/email.service.ts` | Email text now says "Expires in 5 minutes" (3 places) |
| `frontend/src/app/(auth)/signup/page.tsx` | 6 input boxes instead of 5; checks for a 6-digit code |
| `frontend/src/app/(auth)/login/page.tsx` | Same |
| `frontend/src/components/auth/ForgotPasswordFlow.tsx` | Same, plus the on-screen text |
| `frontend/src/components/auth/OtpVerificationStep.tsx` | On-screen text now says 6-digit |

Nothing else was touched. No database change is needed.

### Which standard

**NIST SP 800-63B** — the standard normally used to judge authentication:

- A code sent by email or SMS must be valid for **no more than 10 minutes**
- A code must be **at least 6 digits**

Common practice across real products is 5 to 10 minutes. Banks use shorter
windows for money transfers.

So: 5 minutes is comfortably inside the limit, and 6 digits brings us up to the
minimum the standard requires.

### Is this safe? Yes — here is the check

Making a code live longer gives an attacker more time to guess it. That is a
fair objection, so it was checked:

- 6 digits = **900,000** possible codes
- The server already limits wrong attempts to **3 per minute per IP address**
  (`backend/src/graphql/resolvers/auth.resolver.ts`)
- In 5 minutes an attacker gets about **15 tries**
- 15 out of 900,000 is effectively zero chance

The two changes depend on each other. Extending the time **without** going to
6 digits would have been the wrong move. Done together, the system is stronger
than before, not weaker.

### Still open (not done yet)

- `EMAIL_USER` / `EMAIL_PASSWORD` are empty, so no real emails are sent. The
  code is printed in the backend terminal instead
  (`[DEV] Signup OTP for ... : 123456`). Real email must be configured before
  deployment.
- If signup is attempted with an email that exists but was never verified, the
  app says "Email already in use" and offers no way forward. It should offer to
  resend the code instead.
- The signup form inputs have no `autoComplete`, `name` or `id` attributes, so
  Chrome autofills them with whatever saved login it can find.

### How to test

1. Restart the backend and the frontend
2. Sign up with a new email
3. Confirm the screen shows **6** boxes
4. Find the code in the backend terminal
5. Confirm it still works after waiting 2–3 minutes
