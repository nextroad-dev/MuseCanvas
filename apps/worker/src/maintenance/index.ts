import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { db, transaction } from '../../../../packages/database/src/index'
import { dispatchOutbox } from '../queue'
import { bucket, s3 } from '../shared/infra'

export async function maintenance() {
  await dispatchOutbox()
  await db().query("UPDATE generation_jobs SET status='queued',updated_at=now() WHERE status='retry_wait' AND updated_at<now()-interval '10 seconds' AND deleted_at IS NULL")
  const stale = await db().query("UPDATE generation_jobs SET status='queued',error_code='WORKER_RECOVERED',provider_error=NULL,updated_at=now() WHERE status='running' AND updated_at<now()-interval '20 minutes' AND deleted_at IS NULL RETURNING id")
  for (const row of stale.rows) await db().query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.recovered',$1,$2)", [row.id, { jobId: row.id }])
  const deletions = await db().query('SELECT id,user_id FROM deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 10')
  for (const deletion of deletions.rows) { try { const assets = await db().query('SELECT id,object_key FROM assets WHERE created_by=$1 AND deleted_at IS NULL', [deletion.user_id]); for (const asset of assets.rows) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key })); await transaction(async client => { await client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id]); await client.query('UPDATE generation_jobs SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id]); await client.query("UPDATE prompt_optimizations SET deleted_at=COALESCE(deleted_at,now()),input_prompt='',final_prompt=NULL,template_instruction_snapshot=NULL WHERE created_by=$1", [deletion.user_id]); await client.query("UPDATE users SET email=concat('deleted-',id,'@invalid.local') WHERE id=$1", [deletion.user_id]); await client.query('UPDATE deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id]) }) } catch { await db().query("UPDATE deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id]) } }
  const assetDeletions = await db().query('SELECT id,object_key FROM asset_deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 50')
  for (const deletion of assetDeletions.rows) { try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: deletion.object_key })); await db().query('UPDATE asset_deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id]) } catch { await db().query("UPDATE asset_deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id]) } }
}
