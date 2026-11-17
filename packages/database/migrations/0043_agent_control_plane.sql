-- P4 control plane receipts. No definitions, models or work are provisioned here.
CREATE TABLE IF NOT EXISTS agent_session_requests (
  owner_id uuid NOT NULL REFERENCES users(id),
  client_request_key text NOT NULL CHECK(length(client_request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  session_id uuid NOT NULL,
  accepted_response jsonb NOT NULL CHECK(jsonb_typeof(accepted_response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, client_request_key),
  FOREIGN KEY(session_id, owner_id) REFERENCES agent_sessions(id, owner_id)
);
CREATE INDEX IF NOT EXISTS agent_session_requests_session_idx ON agent_session_requests(session_id);
CREATE TABLE IF NOT EXISTS agent_message_receipts (
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  client_message_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  turn_id uuid NOT NULL,
  item_id uuid NOT NULL,
  accepted_input_revision bigint NOT NULL CHECK(accepted_input_revision > 0),
  accepted_response jsonb NOT NULL CHECK(jsonb_typeof(accepted_response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, client_message_id),
  FOREIGN KEY(turn_id, session_id) REFERENCES agent_turns(id, session_id),
  FOREIGN KEY(session_id, item_id) REFERENCES agent_items(session_id, id)
);
CREATE INDEX IF NOT EXISTS agent_message_receipts_turn_idx ON agent_message_receipts(turn_id);
CREATE OR REPLACE FUNCTION agent_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable agent admission receipt';
END;
$$;
DROP TRIGGER IF EXISTS agent_session_request_immutable_trigger ON agent_session_requests;
CREATE TRIGGER agent_session_request_immutable_trigger BEFORE UPDATE ON agent_session_requests
  FOR EACH ROW EXECUTE FUNCTION agent_receipt_immutable();
DROP TRIGGER IF EXISTS agent_message_receipt_immutable_trigger ON agent_message_receipts;
CREATE TRIGGER agent_message_receipt_immutable_trigger BEFORE UPDATE ON agent_message_receipts
  FOR EACH ROW EXECUTE FUNCTION agent_receipt_immutable();

-- Last pruned cursor, not first retained cursor. P4 does not run a pruning job.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS event_retention_floor bigint NOT NULL DEFAULT 0 CHECK(event_retention_floor >= 0);
CREATE OR REPLACE FUNCTION agent_retention_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_retention_floor < OLD.event_retention_floor OR NEW.event_retention_floor >= NEW.next_event_cursor THEN
    RAISE EXCEPTION 'invalid agent retention floor';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_retention_monotonic_trigger ON agent_sessions;
CREATE TRIGGER agent_retention_monotonic_trigger BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION agent_retention_monotonic();

-- Freeze the parent Turn revision at which a decision was recorded; this is not an entity counter.
ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS decision_revision bigint;
UPDATE agent_approvals a SET decision_revision=t.revision FROM agent_turns t
  WHERE a.turn_id=t.id AND a.session_id=t.session_id AND a.status<>'pending' AND a.decision_revision IS NULL;
ALTER TABLE agent_approvals DROP CONSTRAINT IF EXISTS agent_approval_decision_revision_check;
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approval_decision_revision_check
  CHECK((status='pending' AND decision_revision IS NULL) OR (status<>'pending' AND decision_revision IS NOT NULL AND decision_revision>0));

-- Approval identity and final decision are immutable, independently of API validation.
CREATE OR REPLACE FUNCTION agent_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','resolved_by','resolved_at','decision_revision']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','resolved_by','resolved_at','decision_revision']) THEN
    RAISE EXCEPTION 'immutable agent approval binding';
  END IF;
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'immutable agent approval decision';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_approval_immutable_trigger ON agent_approvals;
CREATE TRIGGER agent_approval_immutable_trigger BEFORE UPDATE ON agent_approvals
  FOR EACH ROW EXECUTE FUNCTION agent_approval_immutable();
