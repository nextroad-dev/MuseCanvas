-- Private Artifact v1 annotations. No model history writes and no asset/job FK:
-- safe snapshots survive media provenance cleanup without granting asset access.
CREATE TABLE IF NOT EXISTS agent_artifact_snapshots (
  session_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  artifact_id text NOT NULL CHECK(artifact_id ~ '^(text|media):[0-9a-f-]{36}$'),
  version integer NOT NULL DEFAULT 1 CHECK(version = 1),
  turn_id uuid NOT NULL,
  source_item_id uuid NOT NULL,
  source_sequence bigint NOT NULL CHECK(source_sequence > 0),
  source_created_at timestamptz NOT NULL,
  kind text NOT NULL CHECK(kind IN ('text','image','video')),
  content text,
  asset_id uuid,
  width integer CHECK(width > 0),
  height integer CHECK(height > 0),
  duration_ms bigint CHECK(duration_ms >= 0 AND duration_ms <= 9007199254740991),
  PRIMARY KEY(session_id, artifact_id),
  UNIQUE(session_id, owner_id, artifact_id),
  FOREIGN KEY(session_id, owner_id) REFERENCES agent_sessions(id, owner_id) ON DELETE CASCADE,
  CHECK((kind='text' AND content IS NOT NULL AND asset_id IS NULL AND artifact_id='text:' || source_item_id::text)
    OR (kind IN ('image','video') AND content IS NULL AND asset_id IS NOT NULL AND artifact_id='media:' || asset_id::text))
);
CREATE TABLE IF NOT EXISTS agent_artifact_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  session_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  artifact_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version = 1),
  anchor jsonb NOT NULL CHECK(jsonb_typeof(anchor)='object'),
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_id, owner_id, artifact_id) REFERENCES agent_artifact_snapshots(session_id, owner_id, artifact_id) ON DELETE CASCADE,
  CHECK(resolved = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_artifact_threads_page_idx
  ON agent_artifact_threads(owner_id,session_id,artifact_id,ordinal DESC);
CREATE TABLE IF NOT EXISTS agent_artifact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  thread_id uuid NOT NULL REFERENCES agent_artifact_threads(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS agent_artifact_messages_thread_idx ON agent_artifact_messages(thread_id,ordinal);
CREATE TABLE IF NOT EXISTS agent_artifact_requests (
  owner_id uuid NOT NULL REFERENCES users(id),
  client_request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  thread_id uuid NOT NULL REFERENCES agent_artifact_threads(id) ON DELETE CASCADE,
  PRIMARY KEY(owner_id,client_request_id)
);
CREATE OR REPLACE FUNCTION agent_artifact_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME <> 'agent_artifact_threads' OR
     (to_jsonb(NEW) - ARRAY['resolved','resolved_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['resolved','resolved_at']) THEN
    RAISE EXCEPTION 'immutable artifact v1 annotation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_artifact_snapshot_immutable ON agent_artifact_snapshots;
CREATE TRIGGER agent_artifact_snapshot_immutable BEFORE UPDATE ON agent_artifact_snapshots
  FOR EACH ROW EXECUTE FUNCTION agent_artifact_guard_immutable();
DROP TRIGGER IF EXISTS agent_artifact_thread_immutable ON agent_artifact_threads;
CREATE TRIGGER agent_artifact_thread_immutable BEFORE UPDATE ON agent_artifact_threads
  FOR EACH ROW EXECUTE FUNCTION agent_artifact_guard_immutable();
DROP TRIGGER IF EXISTS agent_artifact_message_immutable ON agent_artifact_messages;
CREATE TRIGGER agent_artifact_message_immutable BEFORE UPDATE ON agent_artifact_messages
  FOR EACH ROW EXECUTE FUNCTION agent_artifact_guard_immutable();
DROP TRIGGER IF EXISTS agent_artifact_request_immutable ON agent_artifact_requests;
CREATE TRIGGER agent_artifact_request_immutable BEFORE UPDATE ON agent_artifact_requests
  FOR EACH ROW EXECUTE FUNCTION agent_artifact_guard_immutable();
