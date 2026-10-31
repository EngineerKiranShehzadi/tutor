# 👋 Start here — joining `feature/integration` (for the second team member)

Follow these steps in order. They take about 10 minutes.

## 1. Get the code

```bash
git fetch origin
git checkout feature/integration
git pull
cd backend  && npm ci
cd ../frontend && npm ci
```

If `npm ci` fails with 403 on `cdn.sheetjs.com`, your network is blocking that site. Switch networks (for example a mobile hotspot) and run it again. The code is fine.

## 2. Set up `backend/.env`

- Copy `backend/.env.example` to `backend/.env`.
- Paste the Neon `DATABASE_URL` you were given privately into `.env`. Never post it in a group chat or commit it.
- Keep `NODE_ENV=development`.
- Put your own long random values in `JWT_SECRET` and `JWT_REFRESH_SECRET`, and make the two different. You can generate one with `openssl rand -hex 32`.

Never commit `.env`. It is already in `.gitignore`, so just don't force-add it.

## 3. Do NOT run `npm run db:setup`

The Neon database is already migrated (up to migration 017, on 31 Oct). You have nothing to set up.

## 4. Start the app

- Start the backend: `cd backend && npm run dev`, on port 5000.
- Start the frontend: `cd frontend && npm run dev`, on port 3000.
- Log out once and log back in. Old browser sessions won't work.

If the backend stops at boot with a message like `XYZ must be a positive integer`, one value in your `.env` is wrong. Fix that line. Numeric settings now fail at boot instead of being silently ignored.

## 5. You don't run the embedding server or the reranker

The backend starts without them. Leave `EMBEDDING_PROVIDER=local-http` and `RERANK_PROVIDER=local-http` exactly as they are in `.env.example`.

| Works normally | Will not work (needs the embedding server) |
|---|---|
| Login, signup, profile | Normal chat questions: you get an error message, which is expected |
| Admin pages, analytics, lectures, videos | Dataset upload or rebuild: don't do it (see below) |
| Greetings and "Summarize this lecture" (needs `GEMINI_API_KEY`) | Anything that creates new chunks and embeds them |
| Your own features that read `lecture_qna_chunks` directly: quizzes, flashcards, mastery, the unanswered-question queue | |

`/api/v1/health/ready` will show the embedding server and reranker as down. That is expected on your machine.

**Never change `EMBEDDING_PROVIDER`** to `openai` or any other value. The vectors in Neon were made with the local BGE model. Another provider makes every lecture read as "not ready".

**Never upload a dataset from your machine.** Without the embedding server the build can't finish. It waits up to 6 hours and then fails, on the real database.

If you need real chat answers to test something, you need a running embedding server. Put its address in `.env` and restart the backend:

```bash
EMBEDDING_SERVER_URL=<server address>/embed
RERANK_SERVER_URL=<server address>/rerank
```

When you're done, remove both lines.

## ⚠️ You are working on the REAL data

Neon holds the real users, lectures, datasets and chats. So:

- Don't run `npm test` or any `test-*` script against it. The tests write data. They should refuse a non-local database, but don't rely on that.
- Don't delete lectures or users, and don't upload or roll back datasets.
- To try something risky, make your own copy of the database first:
  1. Neon console → your project → **Branches** → **New branch**.
  2. Pick `main` as the parent and name it something like `dev-<yourname>`.
  3. Open the new branch → **Connect** → copy its connection string.
  4. Put that string in `DATABASE_URL` in your `.env` and restart the backend.

  Now your changes only touch that copy. To go back to the real data, put the original URL back. Delete the branch when you're done.
