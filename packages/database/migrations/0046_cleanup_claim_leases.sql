-- Additive claims. Deploy with old cleanup runners stopped: old binaries do not fence writes.
ALTER TABLE deletion_jobs
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE asset_deletion_jobs
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE deletion_jobs DROP CONSTRAINT IF EXISTS deletion_jobs_claim_pair;
ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_claim_pair
  CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL));
ALTER TABLE asset_deletion_jobs DROP CONSTRAINT IF EXISTS asset_deletion_jobs_claim_pair;
ALTER TABLE asset_deletion_jobs ADD CONSTRAINT asset_deletion_jobs_claim_pair
  CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX IF NOT EXISTS deletion_jobs_ready_claim_idx
  ON deletion_jobs(next_attempt_at, created_at, id) WHERE completed_at IS NULL AND blocked_at IS NULL;
CREATE INDEX IF NOT EXISTS asset_deletion_jobs_ready_claim_idx
  ON asset_deletion_jobs(next_attempt_at, created_at, id) WHERE completed_at IS NULL AND blocked_at IS NULL;
