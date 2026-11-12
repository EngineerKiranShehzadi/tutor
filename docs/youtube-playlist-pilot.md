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


## Phase 6 — student frontend integration
The Courses page now embeds a personal YouTube courses panel with:
- course status (PREVIEW_ONLY, QUEUED, PROCESSING, PARTIAL, READY, FAILED);
- explicit "Start AI Import" and retry actions, enabled only by local pilot flags;
- automatic progress refresh every five seconds while queued/processing;
- a course-specific question form when at least one video is indexed;
- grounded answers with clickable YouTube video timestamp citations;
- explicit removal of a private course and its indexed chunks;
- individual video ingestion status/error details, to make partial success visible.

The panel uses the existing authenticated Axios client. No access tokens are
stored in browser storage. The backend verifies course ownership on all private
operations. Search, preview and saving do not automatically ingest anything.

### Required validation before calling this feature complete
Run backend/frontend typechecks and offline tests. Then on a throwaway local DB:
1. Test one playlist with at most two videos that have accessible captions.
2. Verify UI status transitions and at least one grounded answer with a valid
   timestamp link. Verify the response cites only the selected student's course.
3. Test another student cannot query or ingest the first student's course ID.
4. Test captions missing, unavailable embeddings, partial success, retry,
   and deleting a course while an import is in progress.
5. Keep the pull request draft until a real integration smoke test passes.


## Phase 8 — real PostgreSQL pipeline integration (deterministic adapters)
- CI now creates an ephemeral PostgreSQL + pgvector instance, applies the
  private course migrations, and runs \`test:personal-youtube-pipeline-db\`.
- The test creates one private course with two videos, feeds synthetic Hindi/
  English timestamped caption cues through the real chunk converter and
  actual \`student_youtube_course_chunks\` INSERT transactions.
- Embeddings are deterministic 1024-dimensional test vectors, not API calls.
- Checks real vector dimensions, caption timestamps, reindex idempotency,
  failed reindex preserving prior chunks, cross-student isolation, and absence
  from the shared lecture Q&A table.
- No live YouTube API, unofficial transcript provider, LLM, reranker, or real
  embeddings are called. Their behavior still requires a separate manual E2E
  smoke test with explicit credentials and permissioned content.


## Phase 11 — optional live local acceptance smoke

**Never run on production.** Use a throwaway local PostgreSQL database and
a fresh STUDENT account. This script creates one personal course and leaves
it for manual inspection; it never deletes it automatically.

Requirements:
- Apply migrations 026–029 to the throwaway DB and start the backend on
  localhost/127.0.0.1, with all three YouTube pilot flags set to \`true\`.
- Configure a valid **server-side** YouTube Data API v3 key, an authorized
  caption source accessible to the experimental local adapter, and working
  embedding/rerank/LLM providers.
- Obtain a fresh student access token via your normal local login workflow.
  Keep tokens in environment variables; never paste them into issues or logs.
- Choose a playlist containing **at least one captioned video**. The pilot
  imports no more than the first two videos.

Run in the backend directory:

\`\`\`bash
export YOUTUBE_SMOKE_CONFIRM=LOCAL_THROWAWAY_DB
export YOUTUBE_SMOKE_BASE_URL=http://127.0.0.1:5000/api/v1
export YOUTUBE_SMOKE_STUDENT_TOKEN='<local-student-access-token>'
export YOUTUBE_SMOKE_PLAYLIST_ID='<public-playlist-id>'
export YOUTUBE_SMOKE_QUESTION='What concept is explained in the introduction?'
# Optional: a different student's token for owner-isolation HTTP tests
export YOUTUBE_SMOKE_OTHER_STUDENT_TOKEN='<second-local-student-token>'
npm run smoke:youtube-personal-live
\`\`\`

The script refuses non-loopback HTTP targets and requires explicit
confirmation. It verifies the pilot is enabled, creates a new personal
course, checks the 1–2 video cap, queues ingestion, polls for up to six
minutes, asks a grounded question, validates video IDs and timestamp URLs,
and optionally checks that another student receives 404 on ask/ingest/delete.
It does **not** print access tokens or the answer text.

A live smoke pass still requires human review of answer correctness and
caption rights; it is not a replacement for security review. The script is
**not** included in CI because live network credentials are intentionally
absent. Do not mark the feature production-ready until this run succeeds
and its result is reviewed.
