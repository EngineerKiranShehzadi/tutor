# YouTube Playlist Pilot — Phase 5

Base: feature/multi-format-ingestion; development branch: feature/youtube-playlist-ingestion-mvp.

## Current functionality

- Authenticated search for five public YouTube playlists, preview up to two videos.
- STUDENT-owned saved playlists and private course preview records.
- Experimental admin-only import to existing shared lectures (disabled by default).
- Experimental student-only caption indexing to **separate student_youtube_course_chunks**, not shared lecture_qna_chunks.
- Private RAG uses existing embedding, reranker, answer generator, input/output guardrails; citations include original YouTube video ID and real caption timestamps.
- Personal course import is explicit; never auto-import on saving a playlist.
- Per-student daily cap of 20 personal questions; at most 60 chunks per video and 2 videos per course.
- Owner checks on every private course operation and on the retrieval SQL.
- No third-party captions are fetched in production; feature flags default off.

## Local smoke testing — mandatory before merging

1. Use a throwaway PostgreSQL database with pgvector; run backend `npm run db:migrate` after reviewing migrations 026–029.
2. Install backend dependencies and `python3 -m pip install -r backend/scripts/youtube_requirements.txt`.
3. Set `YOUTUBE_PILOT_ENABLED=true`, `YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED=true`,
   `YOUTUBE_STUDENT_RAG_PILOT_ENABLED=true`, and a server-side `YOUTUBE_DATA_API_KEY`.
   Never enable the experimental transcript adapter in production.
4. Run `npm run typecheck`, `npm run test:youtube-pilot`, `npm run test:youtube-import`,
   `npm run test:student-youtube-courses`, `npm run test:personal-youtube-rag` in backend;
   run frontend typecheck and existing navigation tests.
5. Log in as student A. POST /api/v1/youtube/my-courses with a valid public playlist ID;
   capture `data.course.id`. POST /api/v1/youtube/my-courses/:id/ingest explicitly.
   Poll GET /api/v1/youtube/my-courses. When READY/PARTIAL, POST
   /api/v1/youtube/my-courses/:id/ask with `{"question":"What is explained?"}`.
6. Log in as student B. Try A's course ID for ask, ingest and delete. All must return 404.
   Check student B's list does not contain A's course. Verify no private chunks appear in shared GraphQL lectures.
7. Test caption-unavailable, rate limit, embedding failure, restart, partial import and deletion.
   Check YouTube timestamp links and no uncited answers.
8. Never run against production data. Do not merge this draft PR until real E2E and permissions tests pass.

## Known limitations and follow-up

- Student UI has Add to My Courses, but the ingest/ask endpoints are not yet wired into a full student tutor page.
- Private RAG uses a bounded, single-pass retrieval path, not all of the existing chat service's decomposition, answer memory, follow-up or streaming features. It reuses the same providers and guardrails.
- The local worker is not a distributed job queue; use a durable lease/claim mechanism before multi-instance deployment.
- The experimental transcript library may be blocked or unavailable; official YouTube metadata access does not imply transcript-download rights.
- No production-ready permissioned transcript provider is configured.
- No real database, network, or provider E2E test has been run in this chat.
