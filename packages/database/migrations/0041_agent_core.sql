-- Additive Agent Core V1 persistence foundation. No definitions or work are admitted here.
CREATE TABLE IF NOT EXISTS agent_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK(version > 0),
  model_policy jsonb NOT NULL CHECK(jsonb_typeof(model_policy) = 'object'),
  instructions text NOT NULL,
  tool_allowlist jsonb NOT NULL CHECK(jsonb_typeof(tool_allowlist) = 'array'),
  budget_policy jsonb NOT NULL CHECK(jsonb_typeof(budget_policy) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, name, version),
  UNIQUE(id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_definitions_system_name_version_uq
  ON agent_definitions(name, version) WHERE owner_id IS NULL;
CREATE INDEX IF NOT EXISTS agent_definitions_owner_idx ON agent_definitions(owner_id, name, version);

CREATE OR REPLACE FUNCTION agent_definition_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent definition versions are immutable except retirement';
END;
$$;
DROP TRIGGER IF EXISTS agent_definition_immutable_trigger ON agent_definitions;
CREATE TRIGGER agent_definition_immutable_trigger BEFORE UPDATE OR DELETE ON agent_definitions
  FOR EACH ROW EXECUTE FUNCTION agent_definition_immutable();

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  agent_definition_id uuid NOT NULL,
  definition_version integer NOT NULL CHECK(definition_version > 0),
  default_canvas_id uuid,
  active_turn_id uuid,
  input_revision bigint NOT NULL DEFAULT 0 CHECK(input_revision >= 0),
  next_item_sequence bigint NOT NULL DEFAULT 1 CHECK(next_item_sequence > 0),
  next_event_cursor bigint NOT NULL DEFAULT 1 CHECK(next_event_cursor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(id, owner_id),
  FOREIGN KEY(agent_definition_id, definition_version) REFERENCES agent_definitions(id, version)
);
CREATE INDEX IF NOT EXISTS agent_sessions_owner_updated_idx ON agent_sessions(owner_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  client_idempotency_key text NOT NULL CHECK(length(client_idempotency_key) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN ('queued','running','waiting_tools','waiting_approval','completed','failed','cancelled')),
  config_snapshot jsonb NOT NULL CHECK(jsonb_typeof(config_snapshot) = 'object'),
  budget_snapshot jsonb NOT NULL CHECK(jsonb_typeof(budget_snapshot) = 'object'),
  engine_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  input_revision bigint NOT NULL DEFAULT 0 CHECK(input_revision >= 0),
  deadline_at timestamptz NOT NULL,
  retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  next_action_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  lease_owner text,
  lease_until timestamptz,
  cancel_requested_at timestamptz,
  terminal_at timestamptz,
  error jsonb CHECK(error IS NULL OR jsonb_typeof(error) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, session_id),
  UNIQUE(session_id, client_idempotency_key),
  CHECK((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK((status IN ('completed','failed','cancelled')) = (terminal_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_one_active_per_session_uq
  ON agent_turns(session_id) WHERE status IN ('queued','running','waiting_tools','waiting_approval');
CREATE INDEX IF NOT EXISTS agent_turns_recovery_idx ON agent_turns(next_action_at, lease_until) WHERE status IN ('queued','running','waiting_tools','waiting_approval');
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_active_turn_session_fk;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_active_turn_session_fk
  FOREIGN KEY(active_turn_id, id) REFERENCES agent_turns(id, session_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS agent_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  turn_id uuid,
  sequence bigint NOT NULL CHECK(sequence > 0),
  item_type text NOT NULL CHECK(item_type IN ('user_message','assistant_message','tool_call','tool_result','approval','artifact_reference','system_event')),
  tool_call_id uuid,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, sequence),
  UNIQUE(session_id, id),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  CHECK(tool_call_id IS NULL OR turn_id IS NOT NULL),
  CHECK(item_type NOT IN ('tool_call','tool_result') OR tool_call_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS agent_items_turn_sequence_idx ON agent_items(turn_id, sequence);

CREATE TABLE IF NOT EXISTS agent_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  turn_id uuid,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  cursor bigint NOT NULL CHECK(cursor > 0),
  entity_revision bigint CHECK(entity_revision > 0),
  item_sequence bigint CHECK(item_sequence > 0),
  event_type text NOT NULL CHECK(event_type IN ('item.created','tool.updated','approval.required','turn.updated')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, cursor),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id)
);
CREATE INDEX IF NOT EXISTS agent_session_events_retention_idx ON agent_session_events(session_id, cursor DESC);

CREATE TABLE IF NOT EXISTS agent_model_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  position integer NOT NULL CHECK(position > 0),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  input_revision bigint NOT NULL CHECK(input_revision >= 0),
  status text NOT NULL CHECK(status IN ('recorded','running','completed','failed','superseded')),
  model_reference_id text NOT NULL,
  usage jsonb CHECK(usage IS NULL OR jsonb_typeof(usage) = 'object'),
  checkpoint jsonb CHECK(checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(turn_id, position),
  UNIQUE(id, turn_id, session_id),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  CHECK((status IN ('completed','failed','superseded')) = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_model_rounds_recovery_idx ON agent_model_rounds(turn_id, status, position);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  round_id uuid NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  provider_call_id text NOT NULL CHECK(length(provider_call_id) BETWEEN 1 AND 512),
  tool_name text NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 200),
  tool_schema_version integer NOT NULL CHECK(tool_schema_version > 0),
  arguments jsonb NOT NULL CHECK(jsonb_typeof(arguments) = 'object'),
  arguments_hash text NOT NULL CHECK(arguments_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN ('recorded','validating','waiting_approval','executing','waiting_external','completed','failed','cancelled','skipped')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
  result jsonb CHECK(result IS NULL OR jsonb_typeof(result) = 'object'),
  error jsonb CHECK(error IS NULL OR jsonb_typeof(error) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, turn_id, session_id),
  UNIQUE(id, turn_id, session_id, arguments_hash),
  UNIQUE(id, round_id, turn_id, session_id),
  UNIQUE(turn_id, provider_call_id),
  UNIQUE(turn_id, idempotency_key),
  UNIQUE(round_id, position),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  FOREIGN KEY(round_id, turn_id, session_id) REFERENCES agent_model_rounds(id, turn_id, session_id)
);
ALTER TABLE agent_items DROP CONSTRAINT IF EXISTS agent_items_tool_call_session_fk;
ALTER TABLE agent_items ADD CONSTRAINT agent_items_tool_call_session_fk
  FOREIGN KEY(tool_call_id, turn_id, session_id) REFERENCES agent_tool_calls(id, turn_id, session_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_items_tool_result_once_uq
  ON agent_items(tool_call_id) WHERE item_type = 'tool_result' AND tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  arguments_hash text NOT NULL CHECK(arguments_hash ~ '^[0-9a-f]{64}$'),
  model_revision text NOT NULL,
  pricing_revision text NOT NULL,
  reservation_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
  expires_at timestamptz NOT NULL,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, turn_id, session_id),
  UNIQUE(tool_call_id, arguments_hash),
  FOREIGN KEY(tool_call_id, turn_id, session_id, arguments_hash) REFERENCES agent_tool_calls(id, turn_id, session_id, arguments_hash),
  CHECK((status = 'pending') = (resolved_at IS NULL)),
  CHECK(status NOT IN ('approved','rejected') OR resolved_by IS NOT NULL),
  CHECK(status <> 'pending' OR resolved_by IS NULL)
);
CREATE INDEX IF NOT EXISTS agent_approvals_pending_expiry_idx ON agent_approvals(expires_at) WHERE status = 'pending';

-- These guards freeze identities/snapshots and prevent stale claims from rolling fencing back.
-- Future repository writes must still compare owner + token + clock_timestamp() < lease_until.
CREATE OR REPLACE FUNCTION agent_guard_turn_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.session_id,NEW.client_idempotency_key,NEW.request_digest,NEW.config_snapshot,NEW.budget_snapshot,NEW.engine_version,NEW.deadline_at,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.session_id,OLD.client_idempotency_key,OLD.request_digest,OLD.config_snapshot,OLD.budget_snapshot,OLD.engine_version,OLD.deadline_at,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable agent turn snapshot';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token OR NEW.fencing_token > OLD.fencing_token + 1
     OR NEW.revision < OLD.revision OR NEW.input_revision < OLD.input_revision THEN
    RAISE EXCEPTION 'nonmonotonic agent turn revision or fence';
  END IF;
  IF NEW.lease_owner IS NOT NULL AND
     (OLD.lease_owner IS NULL OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR (OLD.lease_until <= clock_timestamp() AND NEW.lease_until > OLD.lease_until))
     AND NEW.fencing_token <> OLD.fencing_token + 1 THEN
    RAISE EXCEPTION 'new agent lease requires next fencing token';
  END IF;
  IF OLD.status IN ('completed','failed','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'terminal agent turn cannot reopen';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_turn_update_guard ON agent_turns;
CREATE TRIGGER agent_turn_update_guard BEFORE UPDATE ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION agent_guard_turn_update();

CREATE OR REPLACE FUNCTION agent_guard_session_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.owner_id,NEW.agent_definition_id,NEW.definition_version,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.agent_definition_id,OLD.definition_version,OLD.created_at) THEN
      RAISE EXCEPTION 'immutable agent session scope';
    END IF;
    IF NEW.input_revision < OLD.input_revision OR NEW.next_item_sequence < OLD.next_item_sequence OR NEW.next_event_cursor < OLD.next_event_cursor THEN
      RAISE EXCEPTION 'nonmonotonic agent session cursor';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_definitions d WHERE d.id=NEW.agent_definition_id AND d.version=NEW.definition_version
      AND (d.owner_id IS NULL OR d.owner_id=NEW.owner_id)) THEN
    RAISE EXCEPTION 'agent definition outside owner scope';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_session_scope_guard ON agent_sessions;
CREATE TRIGGER agent_session_scope_guard BEFORE INSERT OR UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION agent_guard_session_scope();

CREATE OR REPLACE FUNCTION agent_guard_tool_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','result','error','updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','result','error','updated_at']) THEN
    RAISE EXCEPTION 'immutable agent tool call identity';
  END IF;
  IF OLD.status IN ('completed','failed','cancelled','skipped') AND
     (NEW.status,NEW.result,NEW.error) IS DISTINCT FROM (OLD.status,OLD.result,OLD.error) THEN
    RAISE EXCEPTION 'agent tool result already final';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_tool_update_guard ON agent_tool_calls;
CREATE TRIGGER agent_tool_update_guard BEFORE UPDATE ON agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION agent_guard_tool_update();
