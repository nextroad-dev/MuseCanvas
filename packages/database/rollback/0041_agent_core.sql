-- Offline disaster recovery only: stop admission/consumers and preserve audit data first.
-- Full reverse order: 0047 -> 0046 -> 0045 -> 0044 -> 0043 -> 0042 -> 0041.
-- 0047 must revert first: agent_artifact_snapshots holds a composite FK to
-- agent_sessions(id, owner_id) that blocks these DROP TABLE statements.
-- 0044 is index-only. 0040 and 0035-0039 are independent of this chain and can
-- be reverted in parallel once 0041-0043 are gone. Application feature rollback is preferred.
DROP TABLE IF EXISTS agent_approvals;
ALTER TABLE IF EXISTS agent_items DROP CONSTRAINT IF EXISTS agent_items_tool_call_session_fk;
DROP TABLE IF EXISTS agent_tool_calls;
DROP TABLE IF EXISTS agent_model_rounds;
DROP TABLE IF EXISTS agent_session_events;
DROP TABLE IF EXISTS agent_items;
ALTER TABLE IF EXISTS agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_active_turn_session_fk;
DROP TABLE IF EXISTS agent_turns;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS agent_definitions;
DROP FUNCTION IF EXISTS agent_definition_immutable();
DROP FUNCTION IF EXISTS agent_guard_turn_update();
DROP FUNCTION IF EXISTS agent_guard_session_scope();
DROP FUNCTION IF EXISTS agent_guard_tool_update();
