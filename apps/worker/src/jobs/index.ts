import { createHash, randomUUID } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { db, transaction } from '../../../../packages/database/src/index'
import { decryptApiKey, generateImages, LanguageModelHttpError, ProviderHttpError } from '../../../../packages/providers/src/index'
import { preprocessPrompt } from '../preprocessing'
import { acquire, release } from '../queue'
import { bucket, consumer, s3 } from '../shared/infra'

async function resolveApiKey(job: { provider_credential_id?: string; adapter: string }): Promise<string | undefined> {
  if (job.provider_credential_id) {
    const cred = await db().query('SELECT api_key_encrypted, enabled FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [job.provider_credential_id])
    if (!cred.rows[0] || !cred.rows[0].enabled || !cred.rows[0].api_key_encrypted) throw new Error('PROVIDER_NOT_CONFIGURED')
    return decryptApiKey(cred.rows[0].api_key_encrypted)
  }
  if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') return undefined
  throw new Error('PROVIDER_NOT_CONFIGURED')
}

export async function processJob(jobId: string): Promise<boolean> {
  const claimed = await transaction(async client => {
    const r = await client.query("SELECT j.*,m.concurrency_limit FROM generation_jobs j JOIN model_configs m ON m.id=j.model_id WHERE j.id=$1 AND j.deleted_at IS NULL FOR UPDATE", [jobId]); const job = r.rows[0]
    if (!job || !['queued', 'retry_wait'].includes(job.status)) return null
    const owner = `${consumer}:${job.id}`
    await client.query("UPDATE generation_jobs SET status='running',started_at=COALESCE(started_at,now()),updated_at=now(),attempt=attempt+1 WHERE id=$1", [job.id]); return { ...job, owner }
  })
  if (!claimed) { const pending = await db().query("SELECT 1 FROM generation_jobs WHERE id=$1 AND status IN('queued','retry_wait') AND deleted_at IS NULL", [jobId]); return !pending.rows[0] }
  let permitAcquired = false
  try {
    const prompt = await preprocessPrompt(claimed)
    const current = await db().query("SELECT status FROM generation_jobs WHERE id=$1 AND deleted_at IS NULL", [claimed.id])
    if (!current.rows[0] || current.rows[0].status === 'canceled') return true
    permitAcquired = await acquire(claimed.model_id, claimed.concurrency_limit, claimed.owner)
    if (!permitAcquired) throw new Error('PROVIDER_BUSY')
    await db().query("UPDATE generation_jobs SET phase='image_generating',updated_at=now() WHERE id=$1", [claimed.id])
    const images = await generateImages({ adapter: claimed.adapter, vendorModelId: claimed.vendor_model_id, baseUrl: claimed.provider_base_url, apiKey: await resolveApiKey(claimed), prompt, size: claimed.size, quality: claimed.quality, count: claimed.count, watermark: claimed.watermark })
    const uploaded: { key: string; image: typeof images[number]; checksum: string }[] = []
    for (const image of images) { const key = `${claimed.created_by}/${randomUUID()}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`; const checksum = createHash('sha256').update(image.data).digest('hex'); await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: image.data, ContentType: image.mimeType, Metadata: { checksum } })); uploaded.push({ key, image, checksum }) }
    const persisted = await transaction(async client => {
      const current = await client.query('SELECT status,deleted_at FROM generation_jobs WHERE id=$1 FOR UPDATE', [claimed.id])
      if (!current.rows[0] || current.rows[0].deleted_at || current.rows[0].status === 'canceled') return
      await client.query("UPDATE generation_jobs SET phase='asset_persisting',updated_at=now() WHERE id=$1", [claimed.id])
      for (const item of uploaded) { const asset = await client.query('INSERT INTO assets(created_by,job_id,prompt,object_key,mime_type,width,height,size_bytes,checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [claimed.created_by, claimed.id, prompt, item.key, item.image.mimeType, item.image.width, item.image.height, item.image.data.length, item.checksum]); await client.query('INSERT INTO generation_outputs(job_id,asset_id) VALUES($1,$2)', [claimed.id, asset.rows[0].id]) }
      await client.query("UPDATE generation_jobs SET status='succeeded',phase='completed',completed_at=now(),updated_at=now(),error_code=NULL,provider_error=NULL WHERE id=$1", [claimed.id])
      return true
    })
    if (!persisted) for (const item of uploaded) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key }))
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'GENERATION_FAILED'; const temporary = ['PROVIDER_TEMPORARY_ERROR','PROVIDER_DOWNLOAD_FAILED','PROVIDER_BUSY','PROMPT_OPTIMIZATION_TEMPORARY_ERROR','LANGUAGE_MODEL_RESPONSE_INVALID','PROMPT_TEMPLATE_SELECTION_INVALID','PROMPT_OUTPUT_INVALID'].includes(code); const retryable = temporary && claimed.attempt < 2
    const phase = code.startsWith('PROMPT_TEMPLATE') ? 'template_failed' : code.startsWith('PROMPT_') || code.startsWith('LANGUAGE_') ? 'optimization_failed' : 'generation_failed'
    const providerError = error instanceof ProviderHttpError || error instanceof LanguageModelHttpError ? error.diagnostic : null
    await transaction(async client => { if (claimed.prompt_optimization_id && phase !== 'generation_failed') await client.query("UPDATE prompt_optimizations SET status='failed',error_code=$2,completed_at=CASE WHEN $3 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1", [claimed.prompt_optimization_id, code, retryable]); await client.query(`UPDATE generation_jobs SET status=$2,phase=$3,error_code=$4,provider_error=$5,provider_reference_id=COALESCE($6,provider_reference_id),completed_at=${retryable ? 'NULL' : 'now()'},updated_at=now() WHERE id=$1 AND status='running'`, [claimed.id, retryable ? 'retry_wait' : 'failed', phase, code, providerError, providerError?.providerReferenceId || null]); if (retryable) await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry',$1,$2)", [claimed.id, { jobId: claimed.id }]) })
  } finally { if (permitAcquired) await release(claimed.model_id, claimed.owner) }
  return true
}
