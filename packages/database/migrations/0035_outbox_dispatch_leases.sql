-- Short, atomic claims replace SELECT locks that ended before Redis publication.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS dispatch_token uuid;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at timestamptz;
