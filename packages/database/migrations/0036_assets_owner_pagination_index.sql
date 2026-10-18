-- @migrate transaction=false
-- One concurrent DDL per file: the runner sends the file as one simple query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS assets_owner_active_created_idx
ON assets (created_by, created_at DESC, id DESC) WHERE deleted_at IS NULL;
