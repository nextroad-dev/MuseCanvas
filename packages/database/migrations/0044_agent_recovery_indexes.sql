-- M5 coordinator scan support. Additive, index-only: no row, tenant or contract changes.
-- Deadline sweep: non-terminal turns ordered by the immutable deadline.
CREATE INDEX IF NOT EXISTS agent_turns_deadline_recovery_idx
  ON agent_turns(deadline_at, id)
  WHERE status IN ('queued','running','waiting_tools','waiting_approval');
-- Cancellation finalization: only turns that actually hold cancellation intent.
CREATE INDEX IF NOT EXISTS agent_turns_cancel_recovery_idx
  ON agent_turns(cancel_requested_at, id)
  WHERE cancel_requested_at IS NOT NULL AND status IN ('queued','running','waiting_tools','waiting_approval');
-- Media reconciler: waiting_external tools are scanned by least-recently-updated.
CREATE INDEX IF NOT EXISTS agent_tool_calls_waiting_external_idx
  ON agent_tool_calls(updated_at, id)
  WHERE status = 'waiting_external';
-- Outbox backlog/quarantine visibility; pending dispatch already has 0042 indexes.
CREATE INDEX IF NOT EXISTS outbox_events_quarantine_idx
  ON outbox_events(quarantined_at)
  WHERE quarantined_at IS NOT NULL;
