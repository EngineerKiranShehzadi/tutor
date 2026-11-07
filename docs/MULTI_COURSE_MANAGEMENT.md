# Multi-Course Management (AskAITutor)

Branch: `feature/multi-format-ingestion`

## What is implemented

Courses are first-class records. Admins can create and edit a course with a title,
subtitle and description, and choose a course when creating a lecture. Each lecture
still has **its own AI agent, dataset, dataset versions, chat history and YouTube
video (optional for document-only lectures)**.

Student navigation is intentionally minimal:
- **Courses** in the navbar opens `/courses` and shows database-driven course cards.
- **Lectures** in the navbar opens `/lectures`, retaining the original layout.
- Clicking a course opens `/lectures?courseId=<id>`, reusing that original
  video-and-lecture-list UI filtered to the selected course.
- Clicking a lecture opens the original `/lecture/<id>` page. The sidebar only
  shows lectures from the same course, not lectures from unrelated courses.
- The original FQKII instructor attribution is displayed only for the existing
  original YouTube lecture IDs; new courses are not mislabeled.

Admin screens:
- `/admin/courses`: list courses, create course, edit course, open its lectures.
- `/admin/lectures`: existing lecture cards with course filter.
- `/admin/lectures/create`: existing form with a course dropdown, and
  optional YouTube URL for lectures using uploaded documents only.
- Existing lecture detail/upload page remains in place, including the
  multi-format ingestion work (XLSX/PDF/DOCX/PPTX/TXT/HTML).

## Legacy course migration

`backend/src/db/migrations/022_courses.sql`:

1. Creates `courses`, with no destructive changes to existing content.
2. Seeds the original course exactly once:
   **Generative AI Fundamentals**
   **Master the Art of AI Conversations using ChatGPT**
3. Adds `lectures.course_id` and associates every pre-existing lecture with
   the seeded course, **without replacing the lecture row or its ID**.
4. Requires a course on every lecture; old scripts that insert without
   `course_id` are assigned to the original course through a trigger.
5. Adds an index for per-course lecture lookup.

No lecture rows, chunks, vectors, chat sessions, histories, user data, source
references, YouTube IDs, or agent profiles are deleted or re-created.

A new course with no lectures is still visible in the course catalog. It becomes
usable for RAG after admin adds a lecture, uploads material, and its dataset
activates (READY). Creating a course does not automatically create or embed data.

## Safe deployment

**No migration has been applied to Neon by this implementation.** Do not run
`db:setup` against the production database. Before deploying this branch,
make and verify a database backup, run the migration on a disposable Neon
branch/local Postgres, check all seven legacy lectures retain their old IDs
and sources, then separately approve and execute migration 022 against
production if appropriate. **Deploy the backend and frontend together
after the new migration** because the code expects `courses` and
`lectures.course_id`.

Course selection and operations use existing GraphQL authentication. Only
ADMIN users may create or edit courses, while signed-in students can view
course listings.

## Local tests

`.github/workflows/multi-format-ingestion.yml` runs:
- Existing offline document extractors and ingestion mapping checks.
- Backend and frontend TypeScript type checks.
- A separate throwaway PostgreSQL 17 + pgvector migration test that
  creates seven legacy lectures **before** applying 022, checks the original
  metadata and association, inserts a second course and a legacy-style
  lecture, re-applies 022, and checks nothing was reassigned.

These do not prove the feature on a deployed browser connected to the real
database or LLM providers. Manual QA should include creating a course,
adding a lecture with and without YouTube URL, uploading a document,
seeing the correct course card/student lectures, testing RAG answers,
and ensuring the old seven lectures and their existing chats still work.
