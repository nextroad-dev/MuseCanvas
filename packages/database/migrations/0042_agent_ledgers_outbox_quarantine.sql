-- Durable idempotency, budget accounting, legacy engine pinning, and bounded quarantine.
-- Additional unique keys support ownership FKs without changing historical migrations.
CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_id_owner_uq ON generation_jobs(id, created_by);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_documents_id_owner_uq ON canvas_documents(id, created_by);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_agent_sessions_id_owner_uq ON canvas_agent_sessions(id, created_by);
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_canvas_owner_fk;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_canvas_owner_fk
  FOREIGN KEY(default_canvas_id, owner_id) REFERENCES canvas_documents(id, created_by);
-- Canvas deletion is soft today. Hard deletion must clear the optional context first, never cascade.
CREATE TABLE IF NOT EXISTS agent_tool_job_links (
  tool_call_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  media_job_id uuid NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  dependency_role text NOT NULL CHECK(length(dependency_role) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tool_call_id, media_job_id),
  UNIQUE(tool_call_id, position),
  FOREIGN KEY(session_id, owner_id) REFERENCES agent_sessions(id, owner_id),
  FOREIGN KEY(tool_call_id, turn_id, session_id) REFERENCES agent_tool_calls(id, turn_id, session_id),
  FOREIGN KEY(media_job_id, owner_id) REFERENCES generation_jobs(id, created_by)
);
CREATE INDEX IF NOT EXISTS agent_tool_job_links_media_job_idx ON agent_tool_job_links(media_job_id);
CREATE TABLE IF NOT EXISTS agent_consumed_events (
  consumer_name text NOT NULL CHECK(length(consumer_name) BETWEEN 1 AND 200),
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consumer_name, event_id)
);

CREATE TABLE IF NOT EXISTS agent_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  tool_call_id uuid,
  round_id uuid,
  quota text NOT NULL CHECK(quota IN ('model_calls','tool_calls','media_jobs','media_outputs','input_tokens','output_tokens','estimated_cost','concurrent_media_jobs')),
  reserved_amount numeric(30,9) NOT NULL CHECK(reserved_amount >= 0),
  currency text,
  pricing_revision text,
  status text NOT NULL CHECK(status IN ('reserved','settled','released','unknown')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(turn_id, idempotency_key),
  UNIQUE(id, turn_id, session_id),
  UNIQUE(id, tool_call_id, turn_id, session_id, pricing_revision),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  FOREIGN KEY(tool_call_id, turn_id, session_id) REFERENCES agent_tool_calls(id, turn_id, session_id),
  FOREIGN KEY(tool_call_id, round_id, turn_id, session_id) REFERENCES agent_tool_calls(id, round_id, turn_id, session_id),
  FOREIGN KEY(round_id, turn_id, session_id) REFERENCES agent_model_rounds(id, turn_id, session_id),
  CHECK((quota = 'estimated_cost') = (currency IS NOT NULL)),
  CHECK(quota <> 'estimated_cost' OR (length(currency) > 0 AND pricing_revision IS NOT NULL AND length(pricing_revision) > 0)),
  CHECK(quota = 'estimated_cost' OR reserved_amount = trunc(reserved_amount)),
  CHECK((status IN ('settled','released','unknown')) = (settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_budget_reservations_turn_status_idx ON agent_budget_reservations(turn_id, status);
ALTER TABLE agent_approvals DROP CONSTRAINT IF EXISTS agent_approvals_reservation_fk;
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_reservation_fk
  FOREIGN KEY(reservation_id, tool_call_id, turn_id, session_id, pricing_revision)
    REFERENCES agent_budget_reservations(id, tool_call_id, turn_id, session_id, pricing_revision);

CREATE TABLE IF NOT EXISTS agent_usage_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  reservation_id uuid,
  settlement_key text NOT NULL CHECK(length(settlement_key) BETWEEN 1 AND 512),
  usage_kind text NOT NULL CHECK(usage_kind IN ('estimated','actual','unknown')),
  amount numeric(30,9) NOT NULL CHECK(amount >= 0),
  currency text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(turn_id, settlement_key),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  FOREIGN KEY(reservation_id, turn_id, session_id) REFERENCES agent_budget_reservations(id, turn_id, session_id)
);
CREATE INDEX IF NOT EXISTS agent_usage_entries_turn_idx ON agent_usage_entries(turn_id, created_at);

CREATE TABLE IF NOT EXISTS agent_legacy_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  client_request_key text NOT NULL CHECK(length(client_request_key) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL CHECK(engine_version IN ('legacy','agent-core-v1')),
  legacy_session_id uuid REFERENCES canvas_agent_sessions(id),
  legacy_turn_id uuid REFERENCES canvas_agent_turns(id),
  agent_session_id uuid,
  agent_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(legacy_turn_id, legacy_session_id) REFERENCES canvas_agent_turns(id, session_id),
  FOREIGN KEY(legacy_session_id, owner_id) REFERENCES canvas_agent_sessions(id, created_by),
  UNIQUE(owner_id, client_request_key),
  CHECK((legacy_session_id IS NULL) = (legacy_turn_id IS NULL)),
  CHECK((agent_session_id IS NULL) = (agent_turn_id IS NULL)),
  CHECK((engine_version = 'legacy' AND legacy_session_id IS NOT NULL AND agent_session_id IS NULL)
     OR (engine_version = 'agent-core-v1' AND agent_session_id IS NOT NULL AND legacy_session_id IS NULL))
);
ALTER TABLE agent_legacy_links DROP CONSTRAINT IF EXISTS agent_legacy_links_agent_session_fk;
ALTER TABLE agent_legacy_links ADD CONSTRAINT agent_legacy_links_agent_session_fk
  FOREIGN KEY(agent_session_id, owner_id) REFERENCES agent_sessions(id, owner_id);
ALTER TABLE agent_legacy_links DROP CONSTRAINT IF EXISTS agent_legacy_links_agent_turn_fk;
ALTER TABLE agent_legacy_links ADD CONSTRAINT agent_legacy_links_agent_turn_fk
  FOREIGN KEY(agent_turn_id, agent_session_id) REFERENCES agent_turns(id, session_id);

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS quarantine_code text;
CREATE INDEX IF NOT EXISTS outbox_pending_dispatch_v2_idx
  ON outbox_events(created_at) WHERE dispatched_at IS NULL AND quarantined_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_event_type_dispatch_idx
  ON outbox_events(event_type, dispatched_at, created_at);

-- Admission keys must remain pinned through feature-flag changes and retries.
CREATE OR REPLACE FUNCTION agent_guard_legacy_link_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'immutable agent engine admission mapping';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_legacy_link_update_guard ON agent_legacy_links;
CREATE TRIGGER agent_legacy_link_update_guard BEFORE UPDATE ON agent_legacy_links
  FOR EACH ROW EXECUTE FUNCTION agent_guard_legacy_link_update();
