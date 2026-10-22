-- Stop all API and worker instances and deploy the previous version before applying.
-- Refuses to run while any row selects the local driver: the previous code would read the
-- S3 fields for such a row. Switch the row back to 's3' and re-verify it first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM object_storage_settings WHERE storage_driver = 'local') THEN
    RAISE EXCEPTION 'object_storage_settings still selects storage_driver=local; switch it to s3 before rolling back 0040';
  END IF;
END $$;
ALTER TABLE object_storage_settings DROP CONSTRAINT IF EXISTS object_storage_settings_local_root_required_check;
ALTER TABLE object_storage_settings DROP CONSTRAINT IF EXISTS object_storage_settings_local_root_check;
ALTER TABLE object_storage_settings DROP CONSTRAINT IF EXISTS object_storage_settings_storage_driver_check;
ALTER TABLE object_storage_settings DROP COLUMN IF EXISTS local_root;
ALTER TABLE object_storage_settings DROP COLUMN IF EXISTS storage_driver;
