DO $$
BEGIN
  IF to_regclass('agent_approvals') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS agent_approval_immutable_trigger ON agent_approvals;
  END IF;
  IF to_regclass('agent_sessions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS agent_retention_monotonic_trigger ON agent_sessions;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS agent_approval_immutable();
DROP FUNCTION IF EXISTS agent_retention_monotonic();
ALTER TABLE IF EXISTS agent_sessions DROP COLUMN IF EXISTS event_retention_floor;
ALTER TABLE IF EXISTS agent_approvals DROP CONSTRAINT IF EXISTS agent_approval_decision_revision_check;
ALTER TABLE IF EXISTS agent_approvals DROP COLUMN IF EXISTS decision_revision;
DROP TABLE IF EXISTS agent_message_receipts;
DROP TABLE IF EXISTS agent_session_requests;
DROP FUNCTION IF EXISTS agent_receipt_immutable();
