import { createHash, randomUUID } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createClient } from 'redis'
import { db, transaction } from '../../../packages/database/src/index'
import { generateImages, decryptApiKey } from '../../../packages/providers/src/index'

const redis = createClient({ url: process.env.REDIS_URL }); redis.on('error', error => console.error('redis error', { code: error.name }))
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' } })
const bucket = process.env.S3_BUCKET || 'musecanvas'; const consumer = `worker-${process.pid}-${randomUUID().slice(0, 8)}`

async function acquire(modelId: string, limit: number, owner: string): Promise<boolean> {
  const key = `permit:${modelId}`; const now = Date.now(); const expires = now + Number(process.env.JOB_LEASE_MS || 600_000)
  const result = await redis.eval(`redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1]) < tonumber(ARGV[2]) then redis.call('ZADD',KEYS[1],ARGV[3],ARGV[4]); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])-tonumber(ARGV[1])+60000); return 1 end; return 0`, { keys: [key], arguments: [String(now), String(limit), String(expires), owner] })
  return result === 1
}
async function release(modelId: string, owner: string) { await redis.zRem(`permit:${modelId}`, owner) }

async function resolveApiKey(job: { provider_credential_id?: string; adapter: string }): Promise<string | undefined> {
  if (job.provider_credential_id) {
    const cred = await db().query('SELECT api_key_encrypted, enabled FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [job.provider_credential_id])
    if (!cred.rows[0] || !cred.rows[0].enabled || !cred.rows[0].api_key_encrypted) throw new Error('PROVIDER_NOT_CONFIGURED')
    return decryptApiKey(cred.rows[0].api_key_encrypted)
  }
  if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') return undefined
  throw new Error('PROVIDER_NOT_CONFIGURED')
}

async function dispatchOutbox() {
  const events = await db().query("SELECT id,aggregate_id FROM outbox_events WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100")
  for (const event of events.rows) { try { await redis.xAdd('muse:generation', '*', { jobId: event.aggregate_id, eventId: event.id }); await db().query('UPDATE outbox_events SET dispatched_at=now(),attempts=attempts+1 WHERE id=$1', [event.id]) } catch { await db().query('UPDATE outbox_events SET attempts=attempts+1 WHERE id=$1', [event.id]) } }
}

async function processJob(jobId: string): Promise<boolean> {
  const claimed = await transaction(async client => {
    const r = await client.query("SELECT j.*,m.concurrency_limit FROM generation_jobs j JOIN model_configs m ON m.id=j.model_id WHERE j.id=$1 FOR UPDATE", [jobId]); const job = r.rows[0]
    if (!job || !['queued', 'retry_wait'].includes(job.status)) return null
    const owner = `${consumer}:${job.id}`; if (!await acquire(job.model_id, job.concurrency_limit, owner)) return null
    await client.query("UPDATE generation_jobs SET status='running',started_at=COALESCE(started_at,now()),updated_at=now(),attempt=attempt+1 WHERE id=$1", [job.id]); return { ...job, owner }
  })
  if (!claimed) { const pending = await db().query("SELECT 1 FROM generation_jobs WHERE id=$1 AND status IN('queued','retry_wait')", [jobId]); return !pending.rows[0] }
  try {
    const images = await generateImages({ adapter: claimed.adapter, vendorModelId: claimed.vendor_model_id, baseUrl: claimed.provider_base_url, apiKey: await resolveApiKey(claimed), prompt: claimed.prompt, size: claimed.size, quality: claimed.quality, count: claimed.count, watermark: claimed.watermark })
    const uploaded: { key: string; image: typeof images[number]; checksum: string }[] = []
    for (const image of images) { const key = `${claimed.created_by}/${randomUUID()}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`; const checksum = createHash('sha256').update(image.data).digest('hex'); await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: image.data, ContentType: image.mimeType, Metadata: { checksum } })); uploaded.push({ key, image, checksum }) }
    const persisted = await transaction(async client => {
      const current = await client.query('SELECT status FROM generation_jobs WHERE id=$1 FOR UPDATE', [claimed.id]); if (current.rows[0]?.status === 'canceled') return
      for (const item of uploaded) { const asset = await client.query('INSERT INTO assets(created_by,job_id,prompt,object_key,mime_type,width,height,size_bytes,checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [claimed.created_by, claimed.id, claimed.prompt, item.key, item.image.mimeType, item.image.width, item.image.height, item.image.data.length, item.checksum]); await client.query('INSERT INTO generation_outputs(job_id,asset_id) VALUES($1,$2)', [claimed.id, asset.rows[0].id]) }
      await client.query("UPDATE generation_jobs SET status='succeeded',completed_at=now(),updated_at=now(),error_code=NULL WHERE id=$1", [claimed.id])
      return true
    })
    if (!persisted) for (const item of uploaded) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key }))
  } catch (error) {
    const code = error instanceof Error ? error.message : 'GENERATION_FAILED'; const retryable = code === 'PROVIDER_TEMPORARY_ERROR' && claimed.attempt < 3
    await transaction(async client => { await client.query(`UPDATE generation_jobs SET status=$2,error_code=$3,completed_at=${retryable ? 'NULL' : 'now()'},updated_at=now() WHERE id=$1 AND status='running'`, [claimed.id, retryable ? 'retry_wait' : 'failed', code]); if (retryable) await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry',$1,$2)", [claimed.id, { jobId: claimed.id }]) })
  } finally { await release(claimed.model_id, claimed.owner) }
  return true
}

async function consume() {
  try { await redis.xGroupCreate('muse:generation', 'workers', '0', { MKSTREAM: true }) } catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error }
  while (true) {
    const messages = await redis.xReadGroup('workers', consumer, { key: 'muse:generation', id: '>' }, { COUNT: 1, BLOCK: 5000 }) as Array<{ messages: Array<{ id: string; message: Record<string, string> }> }> | null
    for (const stream of messages || []) for (const message of stream.messages) { const handled = await processJob(message.message.jobId); if (!handled) { await new Promise(resolve => setTimeout(resolve, 1000)); await redis.xAdd('muse:generation', '*', { jobId: message.message.jobId, eventId: message.message.eventId || 'permit-retry' }) } await redis.xAck('muse:generation', 'workers', message.id) }
  }
}

async function maintenance() {
  await dispatchOutbox()
  await db().query("UPDATE generation_jobs SET status='queued',updated_at=now() WHERE status='retry_wait' AND updated_at<now()-interval '10 seconds'")
  const stale = await db().query("UPDATE generation_jobs SET status='queued',error_code='WORKER_RECOVERED',updated_at=now() WHERE status='running' AND updated_at<now()-interval '20 minutes' RETURNING id")
  for (const row of stale.rows) await db().query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.recovered',$1,$2)", [row.id, { jobId: row.id }])
  const deletions = await db().query('SELECT id,user_id FROM deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 10')
  for (const deletion of deletions.rows) { try { const assets = await db().query('SELECT id,object_key FROM assets WHERE created_by=$1 AND deleted_at IS NULL', [deletion.user_id]); for (const asset of assets.rows) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key })); await transaction(async client => { await client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id]); await client.query('UPDATE generation_jobs SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [deletion.user_id]); await client.query("UPDATE users SET email=concat('deleted-',id,'@invalid.local') WHERE id=$1", [deletion.user_id]); await client.query('UPDATE deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id]) }) } catch { await db().query("UPDATE deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id]) } }
  const assetDeletions = await db().query('SELECT id,object_key FROM asset_deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 50')
  for (const deletion of assetDeletions.rows) { try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: deletion.object_key })); await db().query('UPDATE asset_deletion_jobs SET completed_at=now(),last_error_code=NULL WHERE id=$1', [deletion.id]) } catch { await db().query("UPDATE asset_deletion_jobs SET attempts=attempts+1,last_error_code='CLEANUP_FAILED' WHERE id=$1", [deletion.id]) } }
}

async function main() {
  await redis.connect(); await maintenance(); setInterval(() => maintenance().catch(error => console.error('maintenance failed', { code: error instanceof Error ? error.name : 'ERROR' })), 5000); await consume()
}
main().catch(error => { console.error('worker fatal', { code: error instanceof Error ? error.name : 'ERROR' }); process.exit(1) })
