import { transaction } from '../../../../../packages/database/src/index'

export async function deleteJobWithAssets(userId: string, jobId: string) {
  return transaction(async (client) => {
    const current = await client.query(
      'SELECT id,prompt_optimization_id,deleted_at,status,attempt FROM generation_jobs WHERE id=$1 AND created_by=$2 FOR UPDATE',
      [jobId, userId],
    )
    const job = current.rows[0]
    if (!job) return false

    if (!job.deleted_at) {
      await client.query(
        `UPDATE generation_jobs SET deleted_at=now(),updated_at=now(),status=CASE WHEN status IN('queued','retry_wait','running') THEN 'canceled' ELSE status END,completed_at=CASE WHEN status IN('queued','retry_wait','running') THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1 AND created_by=$2`,
        [jobId, userId],
      )
      if (String(job.status) === 'running') {
        // Mirror the cooperative cancel flow of the API cancel endpoint: record
        // local intent and enqueue provider cancel work so an in-flight remote
        // run reaches a terminal state instead of polling a deleted job.
        await client.query('UPDATE generation_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id=$1', [jobId])
        try {
          await client.query("UPDATE provider_runs SET operation_state='canceling',next_action_at=now(),updated_at=now() WHERE job_id=$1 AND operation_state IN ('submitting','submission_unknown','waiting','importing')", [jobId])
        } catch {
          // provider_runs table may not exist on older databases; outbox carries the intent.
        }
        await client.query(
          "INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key) VALUES('generation.cancel.requested',$1,$2,$3) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
          [jobId, { jobId }, `cancel:${jobId}:a${job.attempt}`],
        )
      }
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
      'UPDATE assets SET deleted_at=now(),updated_at=now() WHERE job_id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id,object_key,poster_object_key,thumbnail_object_key',
      [jobId, userId],
    )
    for (const asset of assets.rows) {
      // One asset can own two objects now (original + derived preview; a video
      // points poster_object_key and thumbnail_object_key at the SAME preview
      // object), so enqueue every distinct key exactly once. Dedupe keeps the
      // (asset_id, object_key) active key from swallowing a duplicate insert.
      const objectKeys = [asset.object_key, asset.poster_object_key, asset.thumbnail_object_key]
        .filter((key: unknown): key is string => Boolean(key))
      const distinctKeys = new Set<string>(objectKeys)
      for (const objectKey of distinctKeys) {
        await client.query(
          'INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [asset.id, objectKey],
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
