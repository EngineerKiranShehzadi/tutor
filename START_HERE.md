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

## 2. Set up `backend/.env` on your own copy of the database

You never point your `.env` at the real database. You work on your own Neon branch: a full copy of the real data that only you change.

1. Get access to the Neon project from the project owner (or ask the owner to create the branch for you and send you its connection string privately).
2. Neon console → the project → **Branches** → **New branch**. Pick `main` as the parent and name it `dev-<yourname>`.
3. Open the new branch → **Connect** → copy its connection string.

Then:

- Copy `backend/.env.example` to `backend/.env`.
- Paste **your branch's** connection string into `DATABASE_URL` in `.env`. Never use the `main` branch's URL, never post a URL in a group chat, and never commit it.
- Keep `NODE_ENV=development`.
- Put your own long random values in `JWT_SECRET` and `JWT_REFRESH_SECRET`, and make the two different. You can generate one with `openssl rand -hex 32`.

Never commit `.env`. It is already in `.gitignore`, so just don't force-add it.

## 3. Do NOT run `npm run db:setup`

The Neon database is already migrated (up to migration 017, on 31 Oct), and a branch made from `main` gets that schema too. You have nothing to set up.

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

**Never change `EMBEDDING_PROVIDER`** to `openai` or any other value. The vectors in Neon were made with the local BGE model. Another provider makes every lecture read as "not ready". The move to Voyage is done once, by the project owner, following `docs/VOYAGE_SWITCH.md`.

**Never upload a dataset from your machine.** Without the embedding server the build can't finish. It waits up to 6 hours and then fails.

If you need real chat answers to test something, you need a running embedding server. Put its address in `.env` and restart the backend:

```bash
EMBEDDING_SERVER_URL=<server address>/embed
RERANK_SERVER_URL=<server address>/rerank
```

When you're done, remove both lines.

## ⚠️ The `main` branch in Neon is the REAL data

Neon's `main` branch holds the real users, lectures, datasets and chats. Your `dev-<yourname>` branch is a copy, so a mistake there never reaches real users. Still:

- Never put the `main` branch's URL in your `.env`. If you think you need the real data, ask the project owner first.
- Don't run `npm test` or any `test-*` script against any Neon branch. The tests write data. They should refuse a non-local database, but don't rely on that.
- Don't delete lectures or users, and don't upload or roll back datasets, even on your branch: your branch is what you test your features against.
- Your branch does not see changes made to the real data after you created it. To get fresh data, open your branch in the Neon console and use **Reset from parent** (this throws away your changes on the branch), then restart the backend.
- If your branch gets into a bad state, delete it and create a new one from `main` the same way.
