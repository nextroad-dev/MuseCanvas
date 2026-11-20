-- Offline disaster recovery only: stop cleanup runners before applying.
-- Claim and lease state on pending jobs is lost; rows revert to legacy ordering.
DROP INDEX IF EXISTS deletion_jobs_ready_claim_idx;
DROP INDEX IF EXISTS asset_deletion_jobs_ready_claim_idx;
ALTER TABLE deletion_jobs DROP CONSTRAINT IF EXISTS deletion_jobs_claim_pair;
ALTER TABLE asset_deletion_jobs DROP CONSTRAINT IF EXISTS asset_deletion_jobs_claim_pair;
ALTER TABLE deletion_jobs
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS blocked_at;
ALTER TABLE asset_deletion_jobs
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS blocked_at;
