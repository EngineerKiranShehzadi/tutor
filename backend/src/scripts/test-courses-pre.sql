-- Run after schema.sql and migrate.sql, BEFORE migration 022, on a throwaway PG.
-- The pre-course lectures imitate the old YouTube playlist.
INSERT INTO lectures (title, youtube_url, youtube_video_id, status)
VALUES
 ('Introductory Lecture','https://www.youtube.com/watch?v=pCNit2x2gjY','pCNit2x2gjY','READY'),
 ('Lecture 1','https://www.youtube.com/watch?v=0YM7Cfp8dIQ','0YM7Cfp8dIQ','READY'),
 ('Lecture 2','https://www.youtube.com/watch?v=1mi-gFalmSQ','1mi-gFalmSQ','READY'),
 ('Lecture 3','https://www.youtube.com/watch?v=CIkEryaQ7ok','CIkEryaQ7ok','READY'),
 ('Lecture 4','https://www.youtube.com/watch?v=IQNZNTdZhZg','IQNZNTdZhZg','READY'),
 ('Lecture 5','https://www.youtube.com/watch?v=Hv8judoCF0g','Hv8judoCF0g','READY'),
 ('Lecture 6','https://www.youtube.com/watch?v=jGsf0ppO3Js','jGsf0ppO3Js','READY');
