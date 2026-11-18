DROP TRIGGER IF EXISTS agent_media_mask_preparation_immutable_trigger ON agent_media_mask_preparations;
DROP FUNCTION IF EXISTS agent_media_mask_preparation_immutable();
DROP INDEX IF EXISTS agent_media_mask_preparations_expiry_idx;
DROP TABLE IF EXISTS agent_media_mask_preparations;
DROP INDEX IF EXISTS media_uploads_id_owner_uq;
