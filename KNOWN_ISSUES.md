# Known Issues & Fixes

---

## Issue 1 — "Network error. Please check your connection." on GraphQL OTP request

### Symptom
- Frontend shows: `Network error. Please check your connection.`
- Backend logs show: `POST /graphql 429`

### Root Cause
The global rate limiter was applied to **all routes** including `/graphql`.
When the Axios refresh-token interceptor looped (~100 requests), it exhausted
the rate limit window. The next `POST /graphql` request got blocked with 429,
which Apollo Client reports as a generic "Network error".

### How to check WITHOUT UI

**Step 1 — Check if rate limit is exhausted:**
```bash
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { requestPasswordReset(input:{email:\"test@test.com\"}) { success message } }"}'
```
If you get `429 Too Many Requests` → rate limit is the issue.

**Step 2 — Check if /graphql is reachable at all:**
```bash
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ _dummy }"}'
```
Expected: `{"data":{"_dummy":true}}`
If you get 429 → restart backend to reset the window.

**Step 3 — Check backend logs for refresh-token loop:**
```bash
# In backend terminal, look for repeated lines like:
# POST /api/v1/auth/refresh-token 401 0.3ms
# If you see 50+ of these → Axios interceptor loop exhausted the limiter
```

### Fix
Rate limiter is now scoped to `/api/v1` only (already applied):
```ts
// app.ts
app.use('/api/v1', globalLimiter, routes);  // ✅ /graphql unaffected
```
If still hitting 429 → **restart the backend** to clear the rate limit window.

---

## Issue 2 — Axios refresh-token loop (pre-existing)

### Symptom
- Backend logs: hundreds of `POST /api/v1/auth/refresh-token 401` in a row
- Eventually hits `429`

### Root Cause
The Axios interceptor in `api.ts` retries on any 401. When no valid session
exists (no refresh token cookie), every retry also returns 401, causing a loop.

### How to check WITHOUT UI
```bash
# Check if refresh token endpoint is actually broken or just has no session:
curl -X POST http://localhost:5000/api/v1/auth/refresh-token \
  -H "Content-Type: application/json"
# Expected when no session: {"success":false,"message":"No refresh token"}  ← normal
# If it hangs or returns 500 → real backend issue
```

### Fix
This is a frontend interceptor bug — not affecting the OTP flow since
`ForgotPasswordFlow` uses Apollo Client (not Axios). No action needed for OTP.
To fix the loop itself: add a check in the interceptor to not retry if the
failed request was itself the refresh-token call.

---

## Quick Diagnostics Checklist

Run these in order when something breaks:

```bash
# 1. Is backend running?
curl http://localhost:5000/api/v1/health

# 2. Is GraphQL reachable?
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ _dummy }"}'

# 3. Is DB connected? (check backend terminal for)
#    ✅  "PostgreSQL connected"
#    ❌  "Failed to connect" → check DB_PASSWORD in backend/.env

# 4. Is migration applied?
psql $DATABASE_URL -c "\d password_reset_tokens"
# Should show the table columns. If "does not exist" → run migration:
psql $DATABASE_URL -f backend/src/db/migrations/002_password_reset_tokens.sql

# 5. Test full OTP flow via curl (no UI needed):

# Step A — Request OTP
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { requestPasswordReset(input:{email:\"your@email.com\"}) { success message } }"}'

# Step B — Check backend terminal for: [DEV] Password Reset OTP for ...: 12345

# Step C — Verify OTP (replace 12345 with actual OTP from logs)
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { verifyOtp(input:{email:\"your@email.com\", code:\"12345\"}) { success message } }"}'

# Step D — Reset password
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { resetPassword(input:{email:\"your@email.com\", newPassword:\"NewPass1\", confirmPassword:\"NewPass1\"}) { success message } }"}'
```
