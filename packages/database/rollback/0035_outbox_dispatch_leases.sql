-- Stop all workers and deploy the previous worker version before applying.
-- Outbox events and dispatched history are preserved; expired claims may redeliver.
ALTER TABLE outbox_events DROP COLUMN IF EXISTS dispatch_token;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS dispatch_lease_expires_at;
