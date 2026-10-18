CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_runs_job_idx
ON provider_runs (job_id, attempt DESC);
