-- Storage driver selection: 's3' (default, existing rows) or 'local' (files on a mounted volume).
-- Additive and rerunnable. Existing rows keep storage_driver = 's3' and their S3 fields unchanged.
-- No existing column is relaxed: endpoint, bucket, access_key_id and the secret columns are already nullable.
ALTER TABLE object_storage_settings ADD COLUMN IF NOT EXISTS storage_driver text NOT NULL DEFAULT 's3';
ALTER TABLE object_storage_settings ADD COLUMN IF NOT EXISTS local_root text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'object_storage_settings'::regclass
      AND conname = 'object_storage_settings_storage_driver_check'
  ) THEN
    ALTER TABLE object_storage_settings ADD CONSTRAINT object_storage_settings_storage_driver_check
      CHECK (storage_driver IN ('s3','local'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'object_storage_settings'::regclass
      AND conname = 'object_storage_settings_local_root_check'
  ) THEN
    ALTER TABLE object_storage_settings ADD CONSTRAINT object_storage_settings_local_root_check
      CHECK (local_root IS NULL OR (
        length(local_root) BETWEEN 1 AND 512
        AND local_root ~ '^(/|[A-Za-z]:[\\/])'
        AND local_root !~ '(^|[\\/])\.\.([\\/]|$)'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'object_storage_settings'::regclass
      AND conname = 'object_storage_settings_local_root_required_check'
  ) THEN
    ALTER TABLE object_storage_settings ADD CONSTRAINT object_storage_settings_local_root_required_check
      CHECK (storage_driver <> 'local' OR local_root IS NOT NULL);
  END IF;
END $$;
