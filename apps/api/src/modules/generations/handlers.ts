import { transaction } from '../../../../../packages/database/src/index'
import { releaseGenerationCredits } from '../../../../../packages/database/src/index'

export async function deleteJobWithAssets(userId: string, jobId: string) {
  return transaction(async (client) => {
    const current = await client.query(
      'SELECT id,prompt_optimization_id,deleted_at,status FROM generation_jobs WHERE id=$1 AND created_by=$2 FOR UPDATE',
      [jobId, userId],
    )
    const job = current.rows[0]
    if (!job) return false

    if (!job.deleted_at) {
      await client.query(
        `UPDATE generation_jobs SET deleted_at=now(),updated_at=now(),status=CASE WHEN status IN('queued','retry_wait','running') THEN 'canceled' ELSE status END,completed_at=CASE WHEN status IN('queued','retry_wait','running') THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1 AND created_by=$2`,
        [jobId, userId],
      )
    }

    // Release credits if charge was reserved
    const chargeRes = await client.query(
      'SELECT state FROM generation_charges WHERE job_id=$1 FOR UPDATE',
      [jobId]
    )
    if (chargeRes.rows[0]?.state === 'reserved') {
      await releaseGenerationCredits(client, {
        jobId,
        note: `Job deleted by user ${userId}`,
      })
    }

    if (job.prompt_optimization_id)
      await client.query(
        'UPDATE prompt_optimizations SET deleted_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL',
        [job.prompt_optimization_id, userId],
      )
    // Image and video assets alike (posters share the same job), plus any
    // in-flight provider/output state markers so no signed output URL survives
    // privacy deletion in durable state.
    const assets = await client.query(
      'UPDATE assets SET deleted_at=now(),updated_at=now() WHERE job_id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id,object_key,poster_object_key',
      [jobId, userId],
    )
    for (const asset of assets.rows) {
      await client.query(
        'INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [asset.id, asset.object_key],
      )
      if (asset.poster_object_key) {
        await client.query(
          'INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [asset.id, asset.poster_object_key],
        )
      }
    }
    await client.query(
      `UPDATE generation_input_images
       SET status='deleted', deleted_at=now(), updated_at=now()
       WHERE (attached_job_id=$1 OR id IN (SELECT input_image_id FROM generation_job_inputs WHERE job_id=$1))
         AND created_by=$2 AND deleted_at IS NULL`,
      [jobId, userId],
    )
    try {
      await client.query(
        `UPDATE media_uploads
         SET status='deleted', deleted_at=now(), updated_at=now()
         WHERE (attached_job_id=$1 OR id IN (SELECT upload_id FROM generation_job_inputs WHERE job_id=$1))
           AND created_by=$2 AND deleted_at IS NULL`,
        [jobId, userId],
      )
    } catch {
      // media_uploads table may not exist on older databases.
    }
    return true
  })
}
