import type pg from 'pg'
import type { CleanupBlockCode, CleanupWaitCode } from '@musecanvas/database'

export class AccountCleanupDeferred extends Error {
  constructor(readonly code: CleanupBlockCode | CleanupWaitCode) { super(code); this.name = 'AccountCleanupDeferred' }
}

/** Called only inside a short fenced transaction, before deleting any account bytes. */
export async function accountCleanupReadiness(client: pg.PoolClient, ownerId: string): Promise<CleanupBlockCode | CleanupWaitCode | null> {
  const owner = await client.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NOT NULL AND deletion_requested_at IS NOT NULL', [ownerId])
  if (!owner.rows.length) return 'BLOCKED_ACCOUNT_STATE'
  // Cancel intent, not a fabricated media terminal state. Provider maintenance owns convergence.
  await client.query(`UPDATE generation_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),updated_at=now()
    WHERE created_by=$1 AND status IN ('queued','running','retry_wait')`, [ownerId])
  // Preserve Session -> Turn lock order and bound one cleanup pass.
  const sessions = await client.query(`SELECT s.id FROM agent_sessions s WHERE s.owner_id=$1
    AND EXISTS(SELECT 1 FROM agent_turns t WHERE t.session_id=s.id AND t.status NOT IN ('completed','failed','cancelled') AND t.cancel_requested_at IS NULL)
    ORDER BY s.id LIMIT 25 FOR UPDATE OF s SKIP LOCKED`, [ownerId])
  for (const session of sessions.rows) {
    const turns = await client.query(`UPDATE agent_turns SET cancel_requested_at=clock_timestamp(),revision=revision+1,updated_at=now()
      WHERE session_id=$1 AND status NOT IN ('completed','failed','cancelled') AND cancel_requested_at IS NULL RETURNING id,revision`, [session.id])
    for (const turn of turns.rows) {
      await client.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
        VALUES('agent.turn.wake',$1,$2,$3) ON CONFLICT DO NOTHING`, [turn.id,
        { schemaVersion: 1, turnId: turn.id, sessionId: session.id, revision: String(turn.revision) }, `account-deletion-cancel:${turn.id}`])
    }
  }
  const result = await client.query(`SELECT
    (EXISTS(SELECT 1 FROM media_uploads WHERE created_by=$1 AND expires_at>clock_timestamp())
     OR EXISTS(SELECT 1 FROM generation_input_images WHERE created_by=$1 AND expires_at>clock_timestamp())) AS upload_wait,
    (EXISTS(SELECT 1 FROM generation_jobs WHERE created_by=$1 AND status NOT IN ('succeeded','failed','canceled'))
     OR EXISTS(SELECT 1 FROM provider_runs r JOIN generation_jobs j ON j.id=r.job_id WHERE j.created_by=$1
       AND (r.operation_state IN ('submitting','submission_unknown','waiting','importing','canceling') OR r.worker_lease_expires_at>clock_timestamp()))
     OR EXISTS(SELECT 1 FROM output_ingestions i JOIN generation_jobs j ON j.id=i.job_id WHERE j.created_by=$1 AND i.ingestion_state NOT IN ('persisted','failed'))
     OR EXISTS(SELECT 1 FROM outbox_events o JOIN generation_jobs j ON j.id=o.aggregate_id
       WHERE j.created_by=$1 AND o.event_type='media.job.completed' AND o.dispatched_at IS NULL)) AS media_wait,
    (EXISTS(SELECT 1 FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id WHERE s.owner_id=$1
       AND (t.status NOT IN ('completed','failed','cancelled') OR t.lease_until>clock_timestamp()))
     OR EXISTS(SELECT 1 FROM agent_budget_reservations r JOIN agent_sessions s ON s.id=r.session_id
       WHERE s.owner_id=$1 AND r.status IN ('reserved','unknown'))) AS agent_wait,
    (EXISTS(SELECT 1 FROM agent_sessions WHERE owner_id=$1)
     OR EXISTS(SELECT 1 FROM agent_definitions WHERE owner_id=$1)
     OR EXISTS(SELECT 1 FROM agent_media_mask_preparations WHERE owner_id=$1)) AS protected_content,
    (EXISTS(SELECT 1 FROM agent_legacy_links WHERE owner_id=$1)
     OR EXISTS(SELECT 1 FROM agent_approvals a JOIN agent_sessions s ON s.id=a.session_id WHERE a.resolved_by=$1 AND s.owner_id<>$1)
     OR EXISTS(SELECT 1 FROM canvas_agent_turns t JOIN canvas_agent_sessions s ON s.id=t.session_id WHERE s.created_by=$1 AND t.status='running')
     OR EXISTS(SELECT 1 FROM canvas_agent_pending_jobs WHERE created_by=$1 AND status='submitting')) AS protected_reference`, [ownerId])
  const state = result.rows[0]
  if (!state) throw new Error('ACCOUNT_CLEANUP_STATE_UNAVAILABLE')
  if (state.media_wait) return 'WAITING_MEDIA_SETTLEMENT'
  if (state.agent_wait) return 'WAITING_AGENT_SETTLEMENT'
  if (state.upload_wait) return 'WAITING_OBJECT_DELETION'
  if (state.protected_reference) return 'BLOCKED_AGENT_REFERENCE'
  if (state.protected_content) return 'BLOCKED_AGENT_RETENTION_POLICY'
  return null
}
