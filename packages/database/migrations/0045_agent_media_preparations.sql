-- Trusted provenance for masks produced by shared image-edit preparation.
CREATE UNIQUE INDEX IF NOT EXISTS media_uploads_id_owner_uq ON media_uploads(id, created_by);

-- Additive and intentionally separate from legacy Canvas Agent metadata.
CREATE TABLE IF NOT EXISTS agent_media_mask_preparations (
  upload_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  source_checksum text NOT NULL CHECK(source_checksum ~ '^[0-9a-f]{64}$'),
  mask_checksum text NOT NULL CHECK(mask_checksum ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK(width > 0),
  height integer NOT NULL CHECK(height > 0),
  preparation_version integer NOT NULL CHECK(preparation_version = 1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(upload_id, owner_id) REFERENCES media_uploads(id, created_by)
);
CREATE INDEX IF NOT EXISTS agent_media_mask_preparations_expiry_idx
  ON agent_media_mask_preparations(expires_at);

CREATE OR REPLACE FUNCTION agent_media_mask_preparation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prepared Agent media mask identity is immutable';
END;
$$;
DROP TRIGGER IF EXISTS agent_media_mask_preparation_immutable_trigger ON agent_media_mask_preparations;
CREATE TRIGGER agent_media_mask_preparation_immutable_trigger
  BEFORE UPDATE OR DELETE ON agent_media_mask_preparations
  FOR EACH ROW EXECUTE FUNCTION agent_media_mask_preparation_immutable();
