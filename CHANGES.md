# Change Log — AskAITutor

This file records every change made to the code after the FYP-1 evaluation,
with the reason and the standard it follows.

Newest entry at the top.

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
