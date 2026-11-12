-- Admin-only two-video import pilot. No student enrollment is implied.
CREATE TABLE IF NOT EXISTS youtube_import_jobs (
 id BIGSERIAL PRIMARY KEY,
 course_id INT NOT NULL REFERENCES courses(id),
 playlist_id TEXT NOT NULL,
 requested_by UUID NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','READY','PARTIAL','FAILED')),
 total_videos INT NOT NULL DEFAULT 0 CHECK (total_videos BETWEEN 0 AND 2),
 completed_videos INT NOT NULL DEFAULT 0 CHECK (completed_videos BETWEEN 0 AND 2),
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(course_id,playlist_id)
);
CREATE TABLE IF NOT EXISTS youtube_import_videos (
 job_id BIGINT NOT NULL REFERENCES youtube_import_jobs(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL,
 lecture_id INT REFERENCES lectures(id) ON DELETE SET NULL,
 title TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK (status IN ('READY','FAILED','PROCESSING')),
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(job_id,video_id)
);
CREATE INDEX IF NOT EXISTS idx_youtube_import_jobs_status ON youtube_import_jobs(status,updated_at);
