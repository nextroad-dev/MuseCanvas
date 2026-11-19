import { appendMediaJobCompleted, db, transaction } from '@musecanvas/database'
import { dispatchOutbox } from '../queue'
import { deleteStorageObject as deleteSharedStorageObject } from '../shared/storage'
import { resolveUploadSignTtlSeconds } from '../shared/runtime'
import { cleanupClaimedJobs } from './claimed-cleanup'

const DUE_POLL_LIMIT = 50
const CANCEL_SCAN_LIMIT = 50
const STUCK_JOB_LIMIT = 20
/** Longer than any plausible claim -> capacity -> submit window; a run created in that window protects the job. */
export const STUCK_JOB_MIN_AGE_MS = 5 * 60_000

/**
 * Best-effort single-object delete through the shared storage driver.
 * Storage misconfiguration surfaces as STORAGE_NOT_CONFIGURED and is left
 * for the next sweep; object deletes never fail the maintenance tick itself.
 */
async function deleteStorageObject(objectKey: string, signal?: AbortSignal): Promise<void> {
  await deleteSharedStorageObject(objectKey, signal ?? AbortSignal.timeout(10_000))
}

async function recoverExpiredLeases() {
  await db().query(
    `UPDATE provider_runs
     SET worker_lease_token = NULL, worker_lease_expires_at = NULL, updated_at = now()
     WHERE worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at < now()`,
  )
}

async function dispatchDueProviderRuns() {
  const due = await db().query(
    `SELECT id, job_id, state_revision, next_action_at
     FROM provider_runs
     WHERE operation_state IN ('submitting','submission_unknown','waiting','importing','canceling')
       AND (next_action_at IS NULL OR next_action_at <= now())
       AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now())
     ORDER BY next_action_at NULLS FIRST
     LIMIT ${DUE_POLL_LIMIT}`,
  )
  for (const row of due.rows) {
    const dedupeKey = `provider-run-poll:${row.id}:${row.state_revision}`
    await db().query(
      `INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
       VALUES('provider_run.poll',$1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [row.job_id, { jobId: row.job_id, runId: row.id }, dedupeKey],
    )
  }
}

/**
 * A worker that dies between claiming a job (status='running', attempt+1) and
 * creating its provider run leaves no leased row for any other sweeper: the
 * stream delivery is never ACKed and every redelivery throws
 * PRE_RUN_OWNERSHIP_UNAVAILABLE. Requeue such jobs once they are older than any
 * plausible claim->submit window. The guarded UPDATE re-checks the same
 * preconditions, so a job that created a run (or got cancelled) is never touched.
 */
export async function recoverStuckJobs(): Promise<number> {
  const candidates = await db().query(
    `SELECT j.id FROM generation_jobs j
     WHERE j.status='running' AND j.deleted_at IS NULL AND j.cancel_requested_at IS NULL
       AND j.started_at IS NOT NULL
       AND j.started_at < now() - ($1::int * interval '1 millisecond')
       AND NOT EXISTS (SELECT 1 FROM provider_runs r WHERE r.job_id=j.id)
     ORDER BY j.started_at
     LIMIT ${STUCK_JOB_LIMIT}`,
    [STUCK_JOB_MIN_AGE_MS],
  )
  let recovered = 0
  for (const row of candidates.rows) {
    const changed = await transaction(async client => {
      const updated = await client.query(
        `UPDATE generation_jobs SET status='retry_wait',phase='queued_retry',updated_at=now()
         WHERE id=$1 AND status='running' AND deleted_at IS NULL AND cancel_requested_at IS NULL
           AND started_at IS NOT NULL AND started_at < now() - ($2::int * interval '1 millisecond')
           AND NOT EXISTS (SELECT 1 FROM provider_runs WHERE job_id=$1)
         RETURNING attempt,started_at::text AS retry_cycle`,
        [row.id, STUCK_JOB_MIN_AGE_MS],
      )
      const claimed = updated.rows[0] as { attempt: number; retry_cycle: string } | undefined
      if (!claimed) return false
      // Same delivery contract as a pre-run failure: transition and its next
      // delivery commit together, keyed by the claim identity that produced it.
      await client.query(
        `INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
         VALUES('generation.retry',$1,$2::jsonb,$3) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [row.id, JSON.stringify({ jobId: row.id }), `generation.retry:stuck:${row.id}:${claimed.retry_cycle}:${claimed.attempt}`],
      )
      return true
    })
    if (changed) recovered++
  }
  return recovered
}

async function handleCancellations() {
  const jobs = await db().query(
    `SELECT id FROM generation_jobs
     WHERE cancel_requested_at IS NOT NULL AND status IN ('queued','running','retry_wait') AND deleted_at IS NULL
     ORDER BY cancel_requested_at ASC
     LIMIT ${CANCEL_SCAN_LIMIT}`,
  )
  for (const job of jobs.rows) {
    const latest = await db().query(
      'SELECT id, state_revision, operation_state FROM provider_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',
      [job.id],
    )
    const run = latest.rows[0] as Record<string, unknown> | undefined
    if (!run || !['submitting', 'submission_unknown', 'waiting', 'importing', 'canceling'].includes(String(run.operation_state))) {
      await transaction(async client => {
        const current = await client.query("SELECT status FROM generation_jobs WHERE id=$1 FOR UPDATE", [job.id])
        if (!current.rows[0] || !['queued', 'retry_wait'].includes(String(current.rows[0].status))) {
          if (current.rows[0] && String(current.rows[0].status) === 'running' && !run) {
            await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id])
            await appendMediaJobCompleted(client, String(job.id))
          }
          return
        }
        await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id])
        await appendMediaJobCompleted(client, String(job.id))
      })
      continue
    }
    const dedupeKey = `provider-run-cancel:${String(run.id)}:${String(run.state_revision)}`
    await db().query(
      `INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
       VALUES('provider_run.cancel',$1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [job.id, { jobId: job.id, runId: String(run.id) }, dedupeKey],
    )
  }
}

export async function scheduleMaintenance() {
  await dispatchOutbox()
  await recoverExpiredLeases()
  await recoverStuckJobs()
  await dispatchDueProviderRuns()
  await handleCancellations()
}

/** Cleanup has a separate cadence and a bounded storage budget. It never gates dispatch. */
export async function cleanupMaintenance(options: { deleteObject?: (key: string, signal?: AbortSignal) => Promise<void>; now?: () => number; budgetMs?: number } = {}) {
  const now = options.now ?? Date.now
  const deleteObject = options.deleteObject ?? deleteStorageObject
  const deadline = now() + (options.budgetMs ?? 15_000)
  const exhausted = () => now() >= deadline
  await cleanupClaimedJobs({ now, deadline, deleteObject })
  if (exhausted()) return

  // Clean up expired unattached input images (pending or ready past expires_at)
  const expiredInputs = await db().query(
    "SELECT id,object_key FROM generation_input_images WHERE status IN ('pending','ready') AND expires_at < now() AND object_deleted_at IS NULL LIMIT 50",
  )
  for (const item of expiredInputs.rows) {
    if (exhausted()) return
    try {
      await deleteObject(item.object_key)
      await db().query(
        "UPDATE generation_input_images SET status='deleted',deleted_at=COALESCE(deleted_at,now()),object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // failed deletion will be retried on next maintenance run since object_deleted_at remains NULL
    }
  }

  const expiredUploads = await db().query(
    "SELECT id,object_key FROM media_uploads WHERE status IN ('pending','ready') AND expires_at < now() AND object_deleted_at IS NULL LIMIT 50",
  ).catch(() => ({ rows: [] as Array<{ id: string; object_key: string }> }))
  for (const item of expiredUploads.rows) {
    if (exhausted()) return
    try {
      await deleteObject(String(item.object_key))
      await db().query(
        "UPDATE media_uploads SET status='deleted',deleted_at=COALESCE(deleted_at,now()),object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // retried on next maintenance run
    }
  }

  // Signed-URL TTL doubles as the soft-delete grace window; resolved per tick
  // from runtime settings so onboarding changes apply without a restart.
  const uploadSignTtlSeconds = await resolveUploadSignTtlSeconds().catch(() => 900)
  // Clean up soft-deleted input objects whose S3 objects have not yet been marked deleted
  const softDeletedInputs = await db().query(
    `SELECT id,object_key
     FROM generation_input_images
     WHERE status='deleted'
       AND deleted_at < now() - ($1 * interval '1 second')
       AND object_deleted_at IS NULL
     LIMIT 50`,
    [uploadSignTtlSeconds],
  )
  for (const item of softDeletedInputs.rows) {
    if (exhausted()) return
    try {
      await deleteObject(item.object_key)
      await db().query(
        "UPDATE generation_input_images SET object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // retried on next maintenance run
    }
  }

  const softDeletedUploads = await db().query(
    `SELECT id,object_key
     FROM media_uploads
     WHERE status='deleted'
       AND deleted_at < now() - ($1 * interval '1 second')
       AND object_deleted_at IS NULL
     LIMIT 50`,
    [uploadSignTtlSeconds],
  ).catch(() => ({ rows: [] as Array<{ id: string; object_key: string }> }))
  for (const item of softDeletedUploads.rows) {
    if (exhausted()) return
    try {
      await deleteObject(String(item.object_key))
      await db().query(
        "UPDATE media_uploads SET object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // retried on next maintenance run
    }
  }
}

/** Compatibility entry for callers that explicitly request one complete sweep. */
export async function maintenance() {
  await scheduleMaintenance()
  await cleanupMaintenance()
}
