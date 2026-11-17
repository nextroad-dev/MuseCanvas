-- Offline disaster recovery only: stop admission/consumers and preserve audit data first.
-- Apply 0042 rollback before this file; application feature rollback is preferred.
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
