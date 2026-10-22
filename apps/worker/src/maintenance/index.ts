import { db, transaction } from '@musecanvas/database'
import { dispatchOutbox } from '../queue'
import { deleteStorageObject as deleteSharedStorageObject } from '../shared/storage'
import { resolveUploadSignTtlSeconds } from '../shared/runtime'
import { purgeCanvasContentForActor } from './canvas-cleanup'

const DUE_POLL_LIMIT = 50
const CANCEL_SCAN_LIMIT = 50

/**
 * Best-effort single-object delete through the shared storage driver.
 * Storage misconfiguration surfaces as STORAGE_NOT_CONFIGURED and is left
 * for the next sweep; object deletes never fail the maintenance tick itself.
 */
async function deleteStorageObject(objectKey: string): Promise<void> {
  await deleteSharedStorageObject(objectKey, AbortSignal.timeout(10_000))
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
          }
          return
        }
        await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id])
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
  await dispatchDueProviderRuns()
  await handleCancellations()
}

/** Cleanup has a separate cadence and a bounded storage budget. It never gates dispatch. */
export async function cleanupMaintenance(options: { deleteObject?: (key: string) => Promise<void>; now?: () => number; budgetMs?: number } = {}) {
  const now = options.now ?? Date.now
  const deleteObject = options.deleteObject ?? deleteStorageObject
  const deadline = now() + (options.budgetMs ?? 15_000)
  const exhausted = () => now() >= deadline
  const deletions = await db().query('SELECT id,user_id FROM deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED')
  for (const deletion of deletions.rows) {
    if (exhausted()) return
    try {
      const assets = await db().query('SELECT id,object_key,thumbnail_object_key,poster_object_key FROM assets WHERE created_by=$1 AND deleted_at IS NULL ORDER BY id LIMIT 50', [deletion.user_id])
      for (const asset of assets.rows) {
        if (exhausted()) return
        for (const key of new Set([asset.object_key, asset.thumbnail_object_key, asset.poster_object_key].filter(Boolean))) {
          await deleteObject(String(key))
        }
        await db().query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE id=$1 AND created_by=$2', [asset.id, deletion.user_id])
      }
      const inputImages = await db().query('SELECT id,object_key FROM generation_input_images WHERE created_by=$1 AND object_deleted_at IS NULL ORDER BY id LIMIT 50', [deletion.user_id])
      for (const img of inputImages.rows) {
        if (exhausted()) return
        await deleteObject(img.object_key)
        await db().query("UPDATE generation_input_images SET object_deleted_at=now(),status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND created_by=$2", [img.id, deletion.user_id])
      }
      const mediaUploads = await db().query('SELECT id,object_key FROM media_uploads WHERE created_by=$1 AND object_deleted_at IS NULL ORDER BY id LIMIT 50', [deletion.user_id])
      for (const upload of mediaUploads.rows) {
        if (exhausted()) return
        await deleteObject(upload.object_key)
        await db().query("UPDATE media_uploads SET object_deleted_at=now(),status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND created_by=$2", [upload.id, deletion.user_id])
      }
      // Confirm an empty sweep before marking the account complete. Each object
      // marker above survives a restart, so large accounts make bounded progress.
      if (assets.rows.length || inputImages.rows.length || mediaUploads.rows.length) continue
      const pendingObjects = await db().query(
        'SELECT 1 FROM asset_deletion_jobs d JOIN assets a ON a.id=d.asset_id WHERE a.created_by=$1 AND d.completed_at IS NULL LIMIT 1',
        [deletion.user_id],
      )
      if (pendingObjects.rows.length) continue
      await transaction(async client => {
        await purgeCanvasContentForActor(client, String(deletion.user_id))
        await client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id])
        await client.query('UPDATE generation_jobs SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id])
        await client.query("UPDATE prompt_optimizations SET deleted_at=COALESCE(deleted_at,now()),input_prompt='',final_prompt=NULL,template_instruction_snapshot=NULL WHERE created_by=$1", [deletion.user_id])
        await client.query("UPDATE generation_input_images SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1", [deletion.user_id])
        await client.query("UPDATE media_uploads SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1", [deletion.user_id])
        await client.query("UPDATE users SET email=concat('deleted-',id,'@invalid.local') WHERE id=$1", [deletion.user_id])
        await client.query('UPDATE deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id])
      })
    } catch {
      await db().query("UPDATE deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id])
    }
  }
  const assetDeletions = await db().query('SELECT id,object_key FROM asset_deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED')
  for (const deletion of assetDeletions.rows) {
    if (exhausted()) return
    try {
      await deleteObject(deletion.object_key)
      await db().query('UPDATE asset_deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id])
    } catch {
      await db().query("UPDATE asset_deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id])
    }
  }

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
