-- Summary storage now lives directly on dataset_versions. This migration is
-- intentionally a no-op for new databases; migration 044 also migrates and
-- removes the legacy lecture_summaries table when it exists.
SELECT 1;
