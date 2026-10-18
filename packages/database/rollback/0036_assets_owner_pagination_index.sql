-- Run outside a transaction, after rolling back application code if needed.
DROP INDEX CONCURRENTLY IF EXISTS assets_owner_active_created_idx;
