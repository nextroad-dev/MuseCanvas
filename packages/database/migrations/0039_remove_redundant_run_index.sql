-- @migrate transaction=false
-- UNIQUE(job_id,attempt) supports all current job-filtered latest-attempt reads.
DROP INDEX CONCURRENTLY IF EXISTS provider_runs_job_idx;
