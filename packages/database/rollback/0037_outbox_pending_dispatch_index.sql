-- Run outside a transaction. No application data is removed.
DROP INDEX CONCURRENTLY IF EXISTS outbox_pending_created_idx;
