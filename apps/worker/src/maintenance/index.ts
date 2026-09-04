import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { db, releaseGenerationCredits, transaction } from '../../../../packages/database/src/index'
import { dispatchOutbox } from '../queue'
import { bucket, s3 } from '../shared/infra'

const configuredUploadSignTtl = Number(process.env.GENERATION_UPLOAD_SIGN_TTL_SECONDS || 900)
const uploadSignTtlSeconds =
  Number.isSafeInteger(configuredUploadSignTtl) &&
  configuredUploadSignTtl >= 60 &&
  configuredUploadSignTtl <= 3600
    ? configuredUploadSignTtl
    : 900

const DUE_POLL_LIMIT = 50
const CANCEL_SCAN_LIMIT = 50

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
            const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id=$1', [job.id])
            if (charge.rowCount && charge.rowCount > 0) {
              await releaseGenerationCredits(client, { jobId: String(job.id) })
            }
          }
          return
        }
        await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id])
        const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id=$1', [job.id])
        if (charge.rowCount && charge.rowCount > 0) {
          await releaseGenerationCredits(client, { jobId: String(job.id) })
        }
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

export async function maintenance() {
  await dispatchOutbox()
  await recoverExpiredLeases()
  await dispatchDueProviderRuns()
  await handleCancellations()
  const deletions = await db().query('SELECT id,user_id FROM deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED')
  for (const deletion of deletions.rows) {
    try {
      const assets = await db().query('SELECT id,object_key FROM assets WHERE created_by=$1 AND deleted_at IS NULL', [deletion.user_id])
      for (const asset of assets.rows) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key }))
      const inputImages = await db().query('SELECT id,object_key FROM generation_input_images WHERE created_by=$1 AND object_deleted_at IS NULL', [deletion.user_id])
      for (const img of inputImages.rows) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: img.object_key }))
        } catch {}
      }
      const mediaUploads = await db().query('SELECT id,object_key FROM media_uploads WHERE created_by=$1 AND object_deleted_at IS NULL', [deletion.user_id]).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))
      for (const upload of (mediaUploads as { rows: Array<{ object_key: string }> }).rows) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: upload.object_key }))
        } catch {}
      }
      await transaction(async client => {
        await client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id])
        await client.query('UPDATE generation_jobs SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id])
        await client.query("UPDATE prompt_optimizations SET deleted_at=COALESCE(deleted_at,now()),input_prompt='',final_prompt=NULL,template_instruction_snapshot=NULL WHERE created_by=$1", [deletion.user_id])
        await client.query("UPDATE generation_input_images SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1", [deletion.user_id])
        await client.query("UPDATE media_uploads SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1").catch(() => {})
        await client.query("UPDATE users SET email=concat('deleted-',id,'@invalid.local') WHERE id=$1", [deletion.user_id])
        await client.query('UPDATE deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id])
      })
    } catch {
      await db().query("UPDATE deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id])
    }
  }
  const assetDeletions = await db().query('SELECT id,object_key FROM asset_deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED')
  for (const deletion of assetDeletions.rows) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: deletion.object_key }))
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
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.object_key }))
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
  for (const item of (expiredUploads as { rows: Array<{ id: string; object_key: string }> }).rows) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.object_key }))
      await db().query(
        "UPDATE media_uploads SET status='deleted',deleted_at=COALESCE(deleted_at,now()),object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // retried on next maintenance run
    }
  }

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
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.object_key }))
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
  for (const item of (softDeletedUploads as { rows: Array<{ id: string; object_key: string }> }).rows) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.object_key }))
      await db().query(
        "UPDATE media_uploads SET object_deleted_at=now(),updated_at=now() WHERE id=$1",
        [item.id],
      )
    } catch {
      // retried on next maintenance run
    }
  }
}
