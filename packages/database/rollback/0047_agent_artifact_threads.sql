-- Offline disaster recovery only: revert before 0041. The snapshot FK would
-- otherwise block the agent core DROP TABLE statements.
DROP TRIGGER IF EXISTS agent_artifact_request_immutable ON agent_artifact_requests;
DROP TRIGGER IF EXISTS agent_artifact_message_immutable ON agent_artifact_messages;
DROP TRIGGER IF EXISTS agent_artifact_thread_immutable ON agent_artifact_threads;
DROP TRIGGER IF EXISTS agent_artifact_snapshot_immutable ON agent_artifact_snapshots;
DROP FUNCTION IF EXISTS agent_artifact_guard_immutable();
DROP INDEX IF EXISTS agent_artifact_messages_thread_idx;
DROP INDEX IF EXISTS agent_artifact_threads_page_idx;
DROP TABLE IF EXISTS agent_artifact_requests;
DROP TABLE IF EXISTS agent_artifact_messages;
DROP TABLE IF EXISTS agent_artifact_threads;
DROP TABLE IF EXISTS agent_artifact_snapshots;
