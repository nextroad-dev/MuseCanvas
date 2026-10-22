-- @migrate transaction=false
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_pending_created_idx
ON outbox_events (created_at) WHERE dispatched_at IS NULL;
