import { transaction } from '../../../../../packages/database/src/index'

export async function deleteJobWithAssets(userId: string, jobId: string) {
  return transaction(async (client) => {
    const current = await client.query(
      'SELECT id,prompt_optimization_id,deleted_at FROM generation_jobs WHERE id=$1 AND created_by=$2 FOR UPDATE',
      [jobId, userId],
    )
    const job = current.rows[0]
    if (!job) return false
    if (!job.deleted_at)
      await client.query(
        `UPDATE generation_jobs SET deleted_at=now(),updated_at=now(),status=CASE WHEN status IN('queued','retry_wait','running') THEN 'canceled' ELSE status END,completed_at=CASE WHEN status IN('queued','retry_wait','running') THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1 AND created_by=$2`,
        [jobId, userId],
      )
    if (job.prompt_optimization_id)
      await client.query(
        'UPDATE prompt_optimizations SET deleted_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL',
        [job.prompt_optimization_id, userId],
      )
    const assets = await client.query(
      'UPDATE assets SET deleted_at=now(),updated_at=now() WHERE job_id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id,object_key',
      [jobId, userId],
    )
    for (const asset of assets.rows)
      await client.query(
        'INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [asset.id, asset.object_key],
      )
    return true
  })
}