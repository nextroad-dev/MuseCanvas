-- Read-only report. Run against an operator-selected database after taking the
-- usual backup. This script never deletes history or changes dispatch leases.
-- Pending/unconfirmed events are excluded regardless of their creation date.
BEGIN READ ONLY;
SELECT count(*) AS dispatched_events_older_than_30_days,
       min(dispatched_at) AS oldest_dispatched_at,
       max(dispatched_at) AS newest_dispatched_at
FROM outbox_events
WHERE dispatched_at < now() - interval '30 days';
SELECT count(*) AS pending_events,
       count(*) FILTER (WHERE dispatch_lease_expires_at > now()) AS actively_leased_events,
       min(created_at) AS oldest_pending_created_at
FROM outbox_events
WHERE dispatched_at IS NULL;
ROLLBACK;
