# YouTube playlist ingestion — controlled pilot

Base: \`feature/multi-format-ingestion\`. Work branch: \`feature/youtube-playlist-ingestion-mvp\`.

## What this first change actually delivers
- Authenticated YouTube Data API playlist discovery (up to five results).
- Embedded preview limited to the first **two** videos per playlist.
- SRT and WebVTT caption file uploads through the existing admin dataset upload endpoint.
- Authentic caption timestamps retained in \`start_time\` and \`end_time\` and indexed through the existing dataset-version pipeline.
- No new database schema, no background scraping, no new embedding system.
- All YouTube search/preview requests disabled by default behind \`YOUTUBE_PILOT_ENABLED\`.

**Not yet delivered:** Add to My Courses, student enrollment, transcript extraction from arbitrary YouTube videos, durable import jobs, course-wide Q&A, or automatic playlist import. Preview does not imply transcript availability. Do not enable an Add button before resource-level authorization and jobs exist.

## Manual validation (first: one playlist, two videos)
1. On a throwaway/local environment, set \`YOUTUBE_PILOT_ENABLED=true\` and \`YOUTUBE_DATA_API_KEY=<server-side key>\` in \`backend/.env\`.
2. Run \`npm run typecheck\` and \`npm run test:youtube-pilot\` inside \`backend\`.
3. Run \`npm run test:document-ingestion\` to confirm prior formats still work.
4. Start backend/frontend. Open Courses as an authenticated user; search for a topic, preview one playlist, confirm no more than two videos are shown.
5. As admin, create/use a **test lecture**, upload an authorized SRT/VTT file through existing dataset upload with \`dryRun=true\`; inspect preview. Then upload for real with \`mode=MERGE\` and verify a ready dataset, caption time references, and lecture-scoped RAG.
6. Verify invalid captions, oversized files, missing API key, disabled pilot, quota errors and unauthorized access fail safely.
7. Do not test against a production DB. Never commit real API keys or unauthorized transcripts.

## Next integration steps
1. Persist source identity + student membership and enforce it on course/lecture/chat read paths (existing courses are globally visible).
2. Add durable Postgres ingestion jobs with per-video checkpointing and 2-video limit.
3. Add authorized caption adapter; optional unofficial caption adapter behind a separate explicit flag, with block/no-caption outcomes.
4. Map playlist to course and video to lecture, feed normalized rows to \`prepareDatasetVersion\` and \`finishDatasetVersion\`.
5. Add Add to My Courses and job progress UX; only after tests pass, increase the cap.
6. Add source-aware replacement, metadata refresh, and timestamp seek links without altering existing RAG safety boundaries.

## Compliance note
YouTube Data API v3 enables metadata search and playlist enumeration, **not** arbitrary third-party caption downloads. The official captions download API requires owner/editor authorization. Use creator-supplied captions or otherwise authorized sources for production; do not make downloading public videos via \`yt-dlp\` a default fallback.


## Phase 2 — admin-only experimental 2-video import
This branch now includes an opt-in, local-only import worker. It is **not**
student Add to My Courses and is **not** a production-ready YouTube caption
integration. Import creates normal public lectures in an existing admin course.

1. Apply migration 026 on a **throwaway local database** using npm run db:migrate.
2. Install Python dependency: python3 -m pip install -r backend/scripts/youtube_requirements.txt
3. In backend/.env set YOUTUBE_PILOT_ENABLED=true,
   YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED=true and YOUTUBE_DATA_API_KEY.
   The import refuses to run when NODE_ENV=production.
4. Run npm run typecheck, npm run test:youtube-pilot,
   npm run test:youtube-import and npm run test:document-ingestion.
5. Login as ADMIN and call POST /api/v1/youtube/imports with JSON
   {"courseId":<existing test course id>,"playlistId":"<valid playlist id>"}.
   Only the first two videos are attempted.
6. Poll GET /api/v1/youtube/imports/<jobId>. A failed/partial job can be
   requeued with POST /api/v1/youtube/imports/<jobId>/retry.
7. Check that successful videos created lectures with READY datasets and
   timestamped RAG citations; missing captions should show a failed video.
8. Verify existing lectures and admin upload flow still work. Do not merge
   before local typecheck, tests, and smoke testing.

The Python extractor uses an unofficial API and can be blocked or fail when
captions are unavailable. It does not download audio/video or bypass access
controls. The official YouTube Data API does not grant access to arbitrary
third-party captions. Production needs an authorized transcript provider.

## Phase 3 — student-owned bookmarks
- Student can explicitly save a verified public playlist into a private
  bookmark list. No ingestion is triggered; this is not a ready course.
- REST endpoints: GET/POST /api/v1/youtube/saved and
  DELETE /api/v1/youtube/saved/:playlistId (STUDENT only).
- Migration 027 stores bookmarks with (user_id, playlist_id) primary key.
- Existing globally visible courses and their RAG permissions are unchanged.
- Saved list requires clicking "Load My Saved Playlists"; it is not automatically
  preloaded. The UI labels entries "AI tutor not ready".
- Next: do not connect student imports to existing shared courses until the
  authorization model covers all GraphQL/REST/chat/retrieval paths.
