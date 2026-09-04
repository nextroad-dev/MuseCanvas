import type pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import {
  captureGenerationCredits,
  acquireModelCapacity,
  acquireWorkerLease,
  db,
  getLatestModelConfigRevision,
  getLatestProviderRunForJob,
  getModelConfigRevisionById,
  getProviderRunById,
  registerOutputIngestion,
  releaseGenerationCredits,
  releaseWorkerLease,
  transaction,
  updateOutputIngestion,
  updateProviderRunState,
  getOutputIngestionByRunIndex,
  type ModelConfigRevisionEntity,
  type ProviderRunEntity,
} from '../../../../packages/database/src/index'
import {
  decryptApiKey,
  decodeCredential,
  generateImages,
  globalProviderRegistry,
  type GeneratedImage,
  type MediaInputImage,
  type MediaRequest,
  type OperationResult,
  type OutputDescriptor,
  type ProviderConfig,
  inspectInputImage,
  LanguageModelHttpError,
  MAX_INPUT_IMAGES,
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  NormalizedProviderError,
  ProviderHttpError,
} from '../../../../packages/providers/src/index'
import { preprocessPrompt } from '../preprocessing'
import { bucket, s3 } from '../shared/infra'
import {
  PROVIDER_LEASE_SECONDS,
  decryptOpaqueState,
  encryptOpaqueState,
  ingestionStorageKey,
  isCancelRequested,
  isNonTerminalRunState,
  nextActionAtForRetryAfter,
  redactForLog,
  shouldCreateNewRun,
  stripOutputManifest,
  submissionUnknownNextActionAt,
} from '../provider-state'

async function resolveApiKey(job: { provider_credential_id?: string; adapter: string }): Promise<string | undefined> {
  if (job.provider_credential_id) {
    const cred = await db().query('SELECT api_key_encrypted, payload_encrypted, enabled FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [job.provider_credential_id])
    if (!cred.rows[0] || !cred.rows[0].enabled) throw new Error('PROVIDER_NOT_CONFIGURED')
    const envelope = cred.rows[0].payload_encrypted || cred.rows[0].api_key_encrypted
    if (!envelope) throw new Error('PROVIDER_NOT_CONFIGURED')
    return decryptApiKey(envelope)
  }
  if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') return undefined
  throw new Error('PROVIDER_NOT_CONFIGURED')
}

export function validateStoredInputImage(
  data: Buffer,
  expected: { mimeType: string; sizeBytes: number; checksum: string },
): { width: number; height: number; mimeType: 'image/png' | 'image/jpeg'; sizeBytes: number } {
  const inspected = inspectInputImage(data)
  if (data.length !== expected.sizeBytes) throw new Error('INVALID_INPUT_IMAGE_SIZE')
  if (inspected.mimeType !== expected.mimeType) throw new Error('INVALID_INPUT_IMAGE')
  const checksum = createHash('sha256').update(data).digest('hex')
  if (!expected.checksum || checksum !== expected.checksum) throw new Error('INVALID_INPUT_IMAGE')
  return inspected
}

export async function loadAndValidateInputImages(
  jobId: string,
): Promise<Array<{ data: Buffer; mimeType: 'image/png' | 'image/jpeg' }> | undefined> {
  const rows = await db().query(
    `SELECT gji.position, gii.id, gii.object_key, gii.mime_type, gii.size_bytes, gii.checksum
     FROM generation_job_inputs gji
     JOIN generation_input_images gii ON gii.id = gji.input_image_id
     WHERE gji.job_id = $1 AND gii.deleted_at IS NULL
     ORDER BY gji.position ASC`,
    [jobId],
  )
  if (!rows.rows.length) return undefined
  if (rows.rows.length > MAX_INPUT_IMAGES) {
    throw new Error('INVALID_INPUT_IMAGE')
  }

  let totalBytes = 0
  const inputImages: Array<{ data: Buffer; mimeType: 'image/png' | 'image/jpeg' }> = []

  for (const row of rows.rows) {
    let s3Res
    try {
      s3Res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.object_key }))
    } catch {
      throw new Error('INPUT_IMAGE_UNAVAILABLE')
    }
    if (!s3Res.Body) {
      throw new Error('INPUT_IMAGE_UNAVAILABLE')
    }

    const contentLength = s3Res.ContentLength
    if (contentLength !== undefined) {
      if (contentLength <= 0 || contentLength > MAX_UPLOAD_IMAGE_BYTES) {
        throw new Error('INVALID_INPUT_IMAGE_SIZE')
      }
      if (totalBytes + contentLength > MAX_UPLOAD_TOTAL_BYTES) {
        throw new Error('INVALID_INPUT_IMAGE_SIZE')
      }
    }

    let data: Buffer
    try {
      const bytes = await s3Res.Body.transformToByteArray()
      data = Buffer.from(bytes)
    } catch {
      throw new Error('INPUT_IMAGE_UNAVAILABLE')
    }

    if (data.length === 0 || data.length > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error('INVALID_INPUT_IMAGE_SIZE')
    }
    totalBytes += data.length
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error('INVALID_INPUT_IMAGE_SIZE')
    }

    const inspected = validateStoredInputImage(data, {
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      checksum: row.checksum,
    })
    inputImages.push({ data, mimeType: inspected.mimeType })
  }

  return inputImages
}

/** Video-aware input resolver: reads media_uploads via upload_id, falls back to legacy helper. */
async function resolveMediaInputImages(jobId: string): Promise<MediaInputImage[] | undefined> {
  let rows: Array<Record<string, unknown>> = []
  try {
    const res = await db().query(
      `SELECT gji.position, gji.role, mu.id, mu.object_key, mu.mime_type, mu.size_bytes, mu.checksum, mu.media_kind
       FROM generation_job_inputs gji
       JOIN media_uploads mu ON mu.id = gji.upload_id
       WHERE gji.job_id = $1 AND mu.deleted_at IS NULL
       ORDER BY gji.position ASC`,
      [jobId],
    )
    rows = res.rows as Array<Record<string, unknown>>
  } catch {
    rows = []
  }
  if (rows.length > 0) {
    const images: MediaInputImage[] = []
    let totalBytes = 0
    for (const row of rows) {
      const mime = String(row.mime_type || '')
      if (!mime.startsWith('image/')) continue
      let s3Res
      try {
        s3Res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: String(row.object_key) }))
      } catch {
        throw new Error('INPUT_IMAGE_UNAVAILABLE')
      }
      if (!s3Res.Body) throw new Error('INPUT_IMAGE_UNAVAILABLE')
      let data: Buffer
      try {
        data = Buffer.from(await s3Res.Body.transformToByteArray())
      } catch {
        throw new Error('INPUT_IMAGE_UNAVAILABLE')
      }
      if (data.length === 0 || data.length > MAX_UPLOAD_IMAGE_BYTES) throw new Error('INVALID_INPUT_IMAGE_SIZE')
      totalBytes += data.length
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw new Error('INVALID_INPUT_IMAGE_SIZE')
      const expected = { mimeType: mime, sizeBytes: Number(row.size_bytes), checksum: String(row.checksum || '') }
      try {
        validateStoredInputImage(data, expected)
      } catch {
        throw new Error('INVALID_INPUT_IMAGE')
      }
      const inspected = inspectInputImage(data)
      images.push({ data, mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, sizeBytes: data.length })
    }
    return images.length > 0 ? images : undefined
  }
  const legacy = await loadAndValidateInputImages(jobId)
  if (!legacy) return undefined
  return legacy.map(item => ({ data: item.data, mimeType: item.mimeType }))
}

export interface PersistJobSuccessInput {
  jobId: string
  createdBy: string
  prompt: string
  uploaded: Array<{
    key: string
    image: { mimeType: string; width?: number | null; height?: number | null; data?: Buffer; durationSeconds?: number | null; fps?: number | null; metadata?: Record<string, unknown> | null }
    checksum: string
    mediaKind?: 'image' | 'video'
    sizeBytes?: number
  }>
}

export async function persistJobSuccess(
  client: pg.PoolClient,
  input: PersistJobSuccessInput,
): Promise<boolean> {
  const current = await client.query(
    'SELECT status,deleted_at FROM generation_jobs WHERE id=$1 FOR UPDATE',
    [input.jobId],
  )
  if (
    !current.rows[0] ||
    current.rows[0].deleted_at ||
    current.rows[0].status === 'canceled' ||
    current.rows[0].status !== 'running'
  ) {
    return false
  }
  await client.query("UPDATE generation_jobs SET phase='asset_persisting',updated_at=now() WHERE id=$1", [
    input.jobId,
  ])
  for (const item of input.uploaded) {
    const mediaKind = item.mediaKind || (String(item.image.mimeType || '').startsWith('video/') ? 'video' : 'image')
    const sizeBytes = item.sizeBytes ?? (item.image.data ? item.image.data.length : 0)
    const metadata = item.image.metadata || {}
    const asset = await client.query(
      'INSERT INTO assets(created_by,job_id,prompt,object_key,mime_type,width,height,size_bytes,checksum,media_kind,duration_seconds,fps,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
      [
        input.createdBy,
        input.jobId,
        input.prompt,
        item.key,
        item.image.mimeType,
        item.image.width ?? null,
        item.image.height ?? null,
        sizeBytes,
        item.checksum,
        mediaKind,
        item.image.durationSeconds ?? null,
        item.image.fps ?? null,
        JSON.stringify(metadata),
      ],
    )
    await client.query('INSERT INTO generation_outputs(job_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      input.jobId,
      asset.rows[0].id,
    ])
  }
  await client.query(
    "UPDATE generation_jobs SET status='succeeded',phase='completed',progress=100,completed_at=now(),updated_at=now(),error_code=NULL,provider_error=NULL WHERE id=$1",
    [input.jobId],
  )
  const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id = $1', [input.jobId])
  if (charge.rowCount && charge.rowCount > 0) {
    await captureGenerationCredits(client, { jobId: input.jobId })
  }
  return true
}

export interface PersistJobFailureInput {
  jobId: string
  promptOptimizationId?: string | null
  phase: string
  code: string
  retryable: boolean
  providerError?: Record<string, unknown> | null
}

export async function persistJobFailure(
  client: pg.PoolClient,
  input: PersistJobFailureInput,
): Promise<boolean> {
  if (input.promptOptimizationId && input.phase !== 'generation_failed') {
    await client.query(
      "UPDATE prompt_optimizations SET status='failed',error_code=$2,completed_at=CASE WHEN $3 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1",
      [input.promptOptimizationId, input.code, input.retryable],
    )
  }
  const updated = await client.query(
    `UPDATE generation_jobs SET status=$2,phase=$3,error_code=$4,provider_error=$5,provider_reference_id=COALESCE($6,provider_reference_id),completed_at=${input.retryable ? 'NULL' : 'now()'},updated_at=now() WHERE id=$1 AND status='running' RETURNING id`,
    [
      input.jobId,
      input.retryable ? 'retry_wait' : 'failed',
      input.phase,
      input.code,
      input.providerError,
      input.providerError?.providerReferenceId || null,
    ],
  )
  if (!input.retryable && updated.rowCount && updated.rowCount > 0) {
    const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id = $1', [input.jobId])
    if (charge.rowCount && charge.rowCount > 0) {
      await releaseGenerationCredits(client, { jobId: input.jobId })
    }
  }
  return Boolean(updated.rowCount && updated.rowCount > 0)
}

type UploadedImage = { key: string; image: GeneratedImage; checksum: string }

async function deleteUploadedObjects(uploaded: Array<{ key: string }>): Promise<void> {
  for (const item of uploaded) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key }))
    } catch (error) {
      console.error('generated media cleanup failed', {
        key: item.key,
        code: error instanceof Error ? error.name : 'STORAGE_DELETE_FAILED',
      })
    }
  }
}

interface ResolvedSnapshot {
  revision: ModelConfigRevisionEntity
  config: ProviderConfig
}

async function resolveSnapshot(job: Record<string, unknown>): Promise<ResolvedSnapshot> {
  const modelId = String(job.model_id)
  let revision: ModelConfigRevisionEntity | null = null
  if (job.model_revision_id) {
    revision = await getModelConfigRevisionById(db(), String(job.model_revision_id))
  }
  if (!revision) {
    revision = await getLatestModelConfigRevision(db(), modelId)
  }
  if (!revision) throw new Error('INVALID_CONFIG')
  const credentialId = revision.credentialId || (job.provider_credential_id as string | undefined) || null
  let rawCredential: unknown = undefined
  let schemaHint: string | undefined
  if (credentialId) {
    const cred = await db().query(
      'SELECT api_key_encrypted, payload_encrypted, schema_id, enabled FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
      [credentialId],
    )
    const row = cred.rows[0] as Record<string, unknown> | undefined
    if (!row || !row.enabled) throw new Error('PROVIDER_NOT_CONFIGURED')
    const envelope = (row.payload_encrypted as string) || (row.api_key_encrypted as string)
    if (!envelope) throw new Error('PROVIDER_NOT_CONFIGURED')
    schemaHint = (row.schema_id as string) || undefined
    try {
      rawCredential = decryptApiKey(envelope)
    } catch {
      throw new Error('INVALID_CREDENTIAL')
    }
  } else if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') {
    rawCredential = undefined
  } else {
    throw new Error('PROVIDER_NOT_CONFIGURED')
  }
  const decoded = rawCredential === undefined
    ? { schema: schemaHint || 'legacy-api-key-v1' as string, apiKey: undefined as unknown as string }
    : decodeCredential(rawCredential, schemaHint || 'legacy-api-key-v1', revision.pluginId, revision.pluginVersion)
  const baseUrl = revision.baseUrl || (job.provider_base_url as string | undefined) || undefined
  const normalized = revision.normalizedConfig || {}
  const config: ProviderConfig = {
    baseUrl,
    credential: decoded,
    timeoutMs: Number((normalized as Record<string, unknown>).timeoutMs || process.env.PROVIDER_TIMEOUT_MS || 300_000),
    maxBytes: Number((normalized as Record<string, unknown>).maxBytes || process.env.MAX_OUTPUT_BYTES || 100_000_000),
  }
  return { revision, config }
}

function buildMediaRequest(job: Record<string, unknown>, prompt: string, inputImages: MediaInputImage[] | undefined, revision: ModelConfigRevisionEntity): MediaRequest {
  const mediaKind = job.media_kind === 'video' ? 'video' : 'image'
  const normalized = (job.normalized_request as Record<string, unknown> | null) || null
  const params = (normalized?.parameters as Record<string, unknown> | undefined) || {}
  const vendorModelId = revision.vendorModelId || String(job.vendor_model_id || '')
  const count = Number(params.count ?? job.count ?? 1)
  const size = (params.size as string) || (job.size as string) || undefined
  const quality = (params.quality as string) || (job.quality as string) || undefined
  const watermark = Boolean(params.watermark ?? job.watermark ?? false)
  const durationSeconds = params.durationSeconds !== undefined ? Number(params.durationSeconds)
    : params.duration !== undefined ? Number(params.duration) : undefined
  const fps = params.fps !== undefined ? Number(params.fps) : undefined
  const extra: Record<string, unknown> = {}
  for (const key of ['aspectRatio', 'resolution', 'audio', 'duration', 'seed', 'fps']) {
    if (params[key] !== undefined) extra[key] = params[key]
  }
  if (size && mediaKind === 'video' && !extra.aspectRatio) extra.aspectRatio = size
  return {
    modality: mediaKind,
    vendorModelId,
    prompt,
    size,
    quality,
    count: Number.isSafeInteger(count) && count > 0 ? count : 1,
    watermark,
    durationSeconds: durationSeconds !== undefined && Number.isFinite(durationSeconds) ? durationSeconds : undefined,
    fps: fps !== undefined && Number.isFinite(fps) ? fps : undefined,
    inputImages,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

function classifySubmitError(error: unknown, _pluginId: string): { code: string; retryable: boolean; diagnostic: Record<string, unknown> | null } {
  if (error instanceof NormalizedProviderError) {
    const code = error.message
    const retryable = code === 'PROVIDER_TEMPORARY_ERROR' || code === 'PROVIDER_TIMEOUT' || code === 'OUTPUT_READ_FAILED'
    return { code, retryable, diagnostic: { ...error.diagnostic } }
  }
  if (error instanceof ProviderHttpError || error instanceof LanguageModelHttpError) {
    const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'GENERATION_FAILED'
    const retryable = ['PROVIDER_TEMPORARY_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_DOWNLOAD_FAILED', 'PROVIDER_BUSY'].includes(code)
    return { code, retryable, diagnostic: (error.diagnostic as unknown as Record<string, unknown>) || null }
  }
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'GENERATION_FAILED'
  const retryable = ['PROVIDER_TEMPORARY_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_DOWNLOAD_FAILED', 'PROVIDER_BUSY', 'INPUT_IMAGE_UNAVAILABLE', 'STORAGE_TEMPORARY_ERROR', 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR', 'LANGUAGE_MODEL_RESPONSE_INVALID'].includes(code)
  return { code, retryable, diagnostic: null }
}

async function failRunTerminal(run: ProviderRunEntity, job: Record<string, unknown>, code: string, diagnostic: Record<string, unknown> | null, phase: string): Promise<void> {
  await transaction(async client => {
    await updateProviderRunState(client, {
      runId: run.id,
      expectedStateRevision: run.stateRevision,
      operationState: 'failed',
      error: { code, message: code, retryable: false, details: diagnostic || undefined },
      releaseCapacity: true,
      completed: true,
    }).catch(() => null)
    await persistJobFailure(client, {
      jobId: String(job.id),
      promptOptimizationId: (job.prompt_optimization_id as string | null) || null,
      phase,
      code,
      retryable: false,
      providerError: diagnostic,
    })
  })
}

async function cancelJobWithRun(run: ProviderRunEntity, job: Record<string, unknown>): Promise<void> {
  await transaction(async client => {
    await updateProviderRunState(client, {
      runId: run.id,
      expectedStateRevision: run.stateRevision,
      operationState: 'canceled',
      releaseCapacity: true,
      completed: true,
    }).catch(() => null)
    await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running','retry_wait')", [job.id])
    const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id=$1', [job.id])
    if (charge.rowCount && charge.rowCount > 0) {
      await releaseGenerationCredits(client, { jobId: String(job.id) })
    }
  })
}

async function storeRunWaiting(run: ProviderRunEntity, result: OperationResult): Promise<ProviderRunEntity | null> {
  return updateProviderRunState(db(), {
    runId: run.id,
    expectedStateRevision: run.stateRevision,
    operationState: 'waiting',
    remoteId: result.remoteId ?? null,
    nextActionAt: nextActionAtForRetryAfter(result.retryAfterMs),
    encryptedStatePayload: encryptOpaqueState(result.opaqueState),
    encryptedStateKeyId: result.opaqueState ? 'provider-credentials-key-v1' : null,
    outputManifest: (stripOutputManifest(result.outputs) as unknown as Record<string, unknown> | null) || null,
    providerAccepted: Boolean(result.remoteId),
  })
}

async function storeRunUnknown(run: ProviderRunEntity, result: OperationResult): Promise<ProviderRunEntity | null> {
  return updateProviderRunState(db(), {
    runId: run.id,
    expectedStateRevision: run.stateRevision,
    operationState: 'submission_unknown',
    remoteId: result.remoteId ?? null,
    nextActionAt: result.retryAfterMs ? nextActionAtForRetryAfter(result.retryAfterMs) : submissionUnknownNextActionAt(),
    encryptedStatePayload: encryptOpaqueState(result.opaqueState),
    encryptedStateKeyId: result.opaqueState ? 'provider-credentials-key-v1' : null,
    outputManifest: (stripOutputManifest(result.outputs) as unknown as Record<string, unknown> | null) || null,
  })
}

async function uploadBufferToS3(key: string, data: Buffer, contentType: string): Promise<string | null> {
  const MULTIPART_THRESHOLD = 8_000_000
  const PART_SIZE = 5_000_000
  if (data.length < MULTIPART_THRESHOLD) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType, Metadata: { checksum: createHash('sha256').update(data).digest('hex') } }))
    return null
  }
  const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }))
  const uploadId = (created as unknown as Record<string, unknown>).UploadId as string | undefined
  if (!uploadId) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType }))
    return null
  }
  try {
    const parts: Array<{ ETag?: string; PartNumber: number }> = []
    let partNumber = 1
    for (let offset = 0; offset < data.length; offset += PART_SIZE, partNumber += 1) {
      const chunk = data.subarray(offset, Math.min(offset + PART_SIZE, data.length))
      const uploaded = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: chunk }))
      parts.push({ ETag: (uploaded as unknown as Record<string, unknown>).ETag as string, PartNumber: partNumber })
    }
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }))
    return uploadId
  } catch (error) {
    try { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })) } catch {}
    throw error
  }
}

async function importRunOutputs(run: ProviderRunEntity, job: Record<string, unknown>, revision: ModelConfigRevisionEntity, config: ProviderConfig, outputs: OutputDescriptor[], prompt: string): Promise<void> {
  const requestedCount = Number(job.count ?? 1)
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || outputs.length !== requestedCount) {
    await failRunTerminal(
      run,
      job,
      'PROVIDER_IMAGE_COUNT_MISMATCH',
      { requestedCount, receivedCount: outputs.length },
      'generation_failed',
    )
    return
  }
  const mediaKind = job.media_kind === 'video' ? 'video' : 'image'
  const createdBy = String(job.created_by)
  const plugin = globalProviderRegistry.get(revision.pluginId, revision.pluginVersion)
  const context = globalProviderRegistry.createExecutionContext(revision.pluginId, revision.pluginVersion, { config })
  const manifest = stripOutputManifest(outputs)
  await updateProviderRunState(db(), {
    runId: run.id,
    expectedStateRevision: run.stateRevision,
    operationState: 'importing',
    outputManifest: (manifest as unknown as Record<string, unknown> | null) || null,
    nextActionAt: null,
  }).then(updated => { if (updated) run = updated }).catch(() => {})
  const persistedKeys: string[] = []
  const uploaded: PersistJobSuccessInput['uploaded'] = []
  try {
    for (const descriptor of outputs) {
      const existing = await getOutputIngestionByRunIndex(db(), run.id, descriptor.index).catch(() => null)
      if (existing && (existing as unknown as Record<string, unknown>).ingestionState === 'persisted' && (existing as unknown as Record<string, unknown>).assetId) {
        continue
      }
      const storageKey = ingestionStorageKey(createdBy, run.id, descriptor.index, descriptor.mimeType)
      const ingestion = await registerOutputIngestion(db(), {
        jobId: String(job.id),
        runId: run.id,
        outputIndex: descriptor.index,
        mediaKind,
        storageObjectKey: storageKey,
        metadata: { mimeType: descriptor.mimeType },
      })
      const ingestionId = (ingestion as unknown as Record<string, unknown>).id as string
      await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'downloading', downloadStarted: true }).catch(() => null)
      let bounded
      try {
        bounded = plugin.openOutput
          ? await plugin.openOutput(descriptor, config, context)
          : await context.readOutput(descriptor, { maxBytes: config.maxBytes, timeoutMs: config.timeoutMs })
      } catch {
        await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'failed', error: { code: 'PROVIDER_DOWNLOAD_FAILED', message: 'PROVIDER_DOWNLOAD_FAILED' } }).catch(() => null)
        throw new Error('PROVIDER_DOWNLOAD_FAILED')
      }
      const checksum = createHash('sha256').update(bounded.data).digest('hex')
      await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'uploading', checksum, sizeBytes: bounded.data.length, mimeType: bounded.mimeType }).catch(() => null)
      let multipartId: string | null = null
      try {
        multipartId = await uploadBufferToS3(storageKey, bounded.data, bounded.mimeType)
      } catch {
        await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'failed', error: { code: 'STORAGE_TEMPORARY_ERROR', message: 'STORAGE_TEMPORARY_ERROR' } }).catch(() => null)
        throw new Error('STORAGE_TEMPORARY_ERROR')
      }
      persistedKeys.push(storageKey)
      await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'verifying', multipartUploadId: multipartId, downloadCompleted: true }).catch(() => null)
      uploaded.push({
        key: storageKey,
        image: {
          mimeType: bounded.mimeType,
          width: bounded.width ?? descriptor.width ?? null,
          height: bounded.height ?? descriptor.height ?? null,
          durationSeconds: descriptor.durationSeconds ?? (bounded.metadata?.durationSeconds as number | undefined) ?? null,
          fps: (bounded.metadata?.fps as number | undefined) ?? null,
          metadata: { ...(descriptor.metadata || {}), ...(bounded.metadata || {}) },
        },
        checksum,
        mediaKind,
        sizeBytes: bounded.data.length,
      })
      await updateOutputIngestion(db(), { id: ingestionId, ingestionState: 'persisted', attached: true }).catch(() => null)
    }
    const latest = await getProviderRunById(db(), run.id)
    const revisionNow = latest ? latest.stateRevision : run.stateRevision
    await transaction(async client => {
      const ok = await persistJobSuccess(client, { jobId: String(job.id), createdBy, prompt, uploaded })
      if (!ok) {
        await deleteUploadedObjects(persistedKeys.map(key => ({ key })))
        return
      }
      for (const item of uploaded) {
        const assetRow = await client.query('SELECT id FROM assets WHERE job_id=$1 AND object_key=$2', [job.id, item.key])
        const assetId = assetRow.rows[0]?.id as string | undefined
        if (assetId) {
          const ingestions = await client.query('SELECT id FROM output_ingestions WHERE run_id=$1 AND storage_object_key=$2', [run.id, item.key])
          for (const row of ingestions.rows) {
            await client.query('UPDATE output_ingestions SET asset_id=$1,ingestion_state=$2,attached_at=now(),updated_at=now() WHERE id=$3', [assetId, 'persisted', row.id])
          }
        }
      }
      await updateProviderRunState(client, {
        runId: run.id,
        expectedStateRevision: revisionNow,
        operationState: 'succeeded',
        releaseCapacity: true,
        completed: true,
        nextActionAt: null,
      }).catch(() => null)
    })
  } catch (error) {
    await deleteUploadedObjects(persistedKeys.map(key => ({ key })))
    throw error
  }
}

async function handleTerminalResult(run: ProviderRunEntity, job: Record<string, unknown>, revision: ModelConfigRevisionEntity, config: ProviderConfig, result: OperationResult, prompt: string): Promise<void> {
  if (result.status === 'succeeded' && result.outputs && result.outputs.length > 0) {
    await importRunOutputs(run, job, revision, config, result.outputs, prompt)
    return
  }
  if (result.status === 'canceled') {
    const latest = await getProviderRunById(db(), run.id)
    await cancelJobWithRun(latest || run, job)
    return
  }
  const detail = result.error ? `${result.error.code}: ${result.error.detail}` : 'PROVIDER_EMPTY_RESULT'
  const code = result.error ? result.error.code : 'PROVIDER_EMPTY_RESULT'
  console.error('provider terminal failure', redactForLog({ pluginId: revision.pluginId, code }) as Record<string, unknown>)
  const latest = await getProviderRunById(db(), run.id)
  await failRunTerminal(latest || run, job, code, result.error ? { ...result.error, detail } as unknown as Record<string, unknown> : { detail } as Record<string, unknown>, 'generation_failed')
}

/** Poll a single provider run under a Postgres lease. Exported for maintenance/dispatch. */
export async function pollProviderRun(runId: string): Promise<boolean> {
  const leaseToken = randomUUID()
  const leased = await acquireWorkerLease(db(), { runId, leaseToken, leaseDurationSeconds: PROVIDER_LEASE_SECONDS }).catch(() => null)
  if (!leased) return true
  let run: ProviderRunEntity | null = leased
  try {
    const jobRes = await db().query('SELECT * FROM generation_jobs WHERE id=$1 AND deleted_at IS NULL', [run.jobId])
    const job = jobRes.rows[0] as Record<string, unknown> | undefined
    if (!job) {
      await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, operationState: 'failed', error: { code: 'JOB_NOT_FOUND', message: 'JOB_NOT_FOUND' }, releaseCapacity: true, completed: true }).catch(() => null)
      return true
    }
    if (job.status === 'canceled' || isCancelRequested(job)) {
      await requestRemoteCancel(run, job)
      return true
    }
    if (!isNonTerminalRunState(run.operationState)) return true
    const { revision, config } = await resolveSnapshot(job)
    const opaque = decryptOpaqueState(run.encryptedStatePayload)
    const plugin = globalProviderRegistry.get(revision.pluginId, revision.pluginVersion)
    const context = globalProviderRegistry.createExecutionContext(revision.pluginId, revision.pluginVersion, { config })
    if (!run.remoteId) {
      await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, operationState: 'submission_unknown', nextActionAt: submissionUnknownNextActionAt() }).catch(() => null)
      return true
    }
    let result: OperationResult
    try {
      if (!plugin.poll) {
        result = { status: 'waiting', remoteId: run.remoteId, retryAfterMs: 10_000, opaqueState: opaque }
      } else {
        result = await plugin.poll(run.remoteId, opaque, config, context)
      }
    } catch (error) {
      const classified = classifySubmitError(error, revision.pluginId)
      if (classified.retryable) {
        await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, nextActionAt: nextActionAtForRetryAfter(undefined) }).catch(() => null)
        return true
      }
      await failRunTerminal(run, job, classified.code, classified.diagnostic, 'generation_failed')
      return true
    }
    const fresh = await getProviderRunById(db(), run.id)
    if (!fresh) return true
    run = fresh
    if (result.status === 'waiting' || result.status === 'submission_unknown') {
      const target = result.status === 'submission_unknown' ? 'submission_unknown' : 'waiting'
      await updateProviderRunState(db(), {
        runId: run.id,
        expectedStateRevision: run.stateRevision,
        operationState: target,
        remoteId: result.remoteId ?? run.remoteId,
        nextActionAt: nextActionAtForRetryAfter(result.retryAfterMs),
        encryptedStatePayload: result.opaqueState ? encryptOpaqueState(result.opaqueState) : undefined,
        encryptedStateKeyId: result.opaqueState ? 'provider-credentials-key-v1' : undefined,
        outputManifest: result.outputs ? (stripOutputManifest(result.outputs) as unknown as Record<string, unknown> | null) : undefined,
        providerAccepted: Boolean(result.remoteId),
      }).catch(() => null)
      await db().query("UPDATE generation_jobs SET phase=$2,progress=COALESCE(progress,0),updated_at=now() WHERE id=$1 AND status='running'", [job.id, target === 'waiting' ? 'provider_waiting' : 'provider_submitting']).catch(() => {})
      return true
    }
    const promptRow = await db().query('SELECT prompt FROM generation_jobs WHERE id=$1', [job.id])
    await handleTerminalResult(run, job, revision, config, result, String(promptRow.rows[0]?.prompt || job.prompt || ''))
    return true
  } finally {
    await releaseWorkerLease(db(), runId, leaseToken).catch(() => {})
  }
}

async function requestRemoteCancel(run: ProviderRunEntity, job: Record<string, unknown>): Promise<void> {
  try {
    const { revision, config } = await resolveSnapshot(job)
    const plugin = globalProviderRegistry.get(revision.pluginId, revision.pluginVersion)
    const context = globalProviderRegistry.createExecutionContext(revision.pluginId, revision.pluginVersion, { config })
    const opaque = decryptOpaqueState(run.encryptedStatePayload)
    await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, operationState: 'canceling', nextActionAt: null }).catch(() => null)
    await db().query("UPDATE generation_jobs SET phase='provider_canceling',updated_at=now() WHERE id=$1", [job.id]).catch(() => {})
    if (run.remoteId && plugin.cancel) {
      const result = await plugin.cancel(run.remoteId, opaque, config, context).catch(() => ({ status: 'canceled' as const }))
      if (result.status === 'succeeded' && result.outputs && result.outputs.length > 0) {
        return
      }
    }
  } catch (error) {
    console.error('provider cancel failed', redactForLog({ code: error instanceof Error ? error.name : 'CANCEL_FAILED' }) as Record<string, unknown>)
  } finally {
    const latest = await getProviderRunById(db(), run.id).catch(() => null)
    await cancelJobWithRun(latest || run, job)
  }
}

export async function processJob(jobId: string, runId?: string): Promise<boolean> {
  if (runId) {
    await pollProviderRun(runId)
    return true
  }
  const claimed = await transaction(async client => {
    const r = await client.query('SELECT * FROM generation_jobs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [jobId])
    const job = r.rows[0] as Record<string, unknown> | undefined
    if (!job || !['queued', 'retry_wait'].includes(String(job.status))) return null
    if (isCancelRequested(job)) {
      await client.query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id])
      const charge = await client.query('SELECT 1 FROM generation_charges WHERE job_id=$1', [job.id])
      if (charge.rowCount && charge.rowCount > 0) {
        await releaseGenerationCredits(client, { jobId: String(job.id) })
      }
      return { ...(job as object), status: 'canceled', canceledAtClaim: true } as unknown as Record<string, unknown>
    }
    await client.query("UPDATE generation_jobs SET status='running',started_at=COALESCE(started_at,now()),updated_at=now(),attempt=attempt+1,phase=COALESCE(phase,'preprocessing') WHERE id=$1", [job.id])
    const updated = await client.query('SELECT * FROM generation_jobs WHERE id=$1', [job.id])
    return updated.rows[0] as Record<string, unknown>
  })
  if (!claimed) {
    const latest = await getLatestProviderRunForJob(db(), jobId).catch(() => null)
    if (latest && isNonTerminalRunState(latest.operationState)) {
      await pollProviderRun(latest.id)
    }
    return true
  }
  if ((claimed as Record<string, unknown>).canceledAtClaim) return true
  try {
    const prompt = await preprocessPrompt(claimed)
    const currentRes = await db().query('SELECT * FROM generation_jobs WHERE id=$1 AND deleted_at IS NULL', [claimed.id])
    const current = currentRes.rows[0] as Record<string, unknown> | undefined
    if (!current || current.status === 'canceled' || isCancelRequested(current)) {
      const latest = await getLatestProviderRunForJob(db(), String(claimed.id)).catch(() => null)
      if (latest && isNonTerminalRunState(latest.operationState)) {
        await requestRemoteCancel(latest, current || claimed)
      } else if (current) {
        await db().query("UPDATE generation_jobs SET status='canceled',phase='completed',completed_at=now(),updated_at=now() WHERE id=$1", [claimed.id]).catch(() => {})
      }
      return true
    }
    const existingRun = await getLatestProviderRunForJob(db(), String(claimed.id)).catch(() => null)
    if (existingRun && isNonTerminalRunState(existingRun.operationState)) {
      await pollProviderRun(existingRun.id)
      return true
    }
    const attempt = Number((current || claimed).attempt || 1)
    const { revision, config } = await resolveSnapshot((current || claimed) as Record<string, unknown>)
    const jobRow = (current || claimed) as Record<string, unknown>
    const clientToken = `${String(jobRow.id)}:a${attempt}:${String(revision.id).slice(0, 8)}`
    const idempotent = await transaction(async client => {
      return acquireModelCapacity(client, {
        modelId: String(jobRow.model_id),
        providerId: revision.providerId,
        pluginId: revision.pluginId,
        clientToken,
        jobId: String(jobRow.id),
        attempt,
      })
    })
    if (!idempotent.acquired) {
      const reason = idempotent.reason || 'CONCURRENCY_LIMIT_EXCEEDED'
      if (reason === 'MODEL_NOT_FOUND') {
        await transaction(async client => {
          await persistJobFailure(client, { jobId: String(jobRow.id), promptOptimizationId: (jobRow.prompt_optimization_id as string) || null, phase: 'generation_failed', code: 'INVALID_CONFIG', retryable: false, providerError: null })
        })
        return true
      }
      await db().query("UPDATE generation_jobs SET status='queued',updated_at=now() WHERE id=$1 AND status='running'", [jobRow.id]).catch(() => {})
      await db().query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry',$1,$2)", [jobRow.id, { jobId: jobRow.id }]).catch(() => {})
      return true
    }
    let run: ProviderRunEntity = idempotent.run as ProviderRunEntity
    await db().query("UPDATE generation_jobs SET phase='provider_submitting',provider_id=$2,plugin_id=$3,plugin_version=$4,updated_at=now() WHERE id=$1", [jobRow.id, revision.providerId, revision.pluginId, revision.pluginVersion]).catch(() => {})
    const inputImages = await resolveMediaInputImages(String(jobRow.id)).catch(error => {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_INPUT_IMAGE'
      throw new Error(code)
    })
    const request: MediaRequest = buildMediaRequest(jobRow, prompt, inputImages, revision)
    const plugin = globalProviderRegistry.get(revision.pluginId, revision.pluginVersion)
    const context = globalProviderRegistry.createExecutionContext(revision.pluginId, revision.pluginVersion, { config })
    let result: OperationResult
    try {
      try { await plugin.validateRequest(request, config) } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_REQUEST'
        throw new Error(code)
      }
      result = await plugin.submit(request, config, context)
    } catch (error) {
      if (error instanceof Error && /^(INVALID_REQUEST|INVALID_CONFIG|INVALID_CREDENTIAL|PROVIDER_REJECTED)$/.test(error.message)) {
        await failRunTerminal(run, jobRow, error.message, null, 'generation_failed')
        return true
      }
      const classified = classifySubmitError(error, revision.pluginId)
      if (classified.retryable) {
        await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, operationState: 'submission_unknown', nextActionAt: submissionUnknownNextActionAt(), error: { code: classified.code, message: classified.code, retryable: true } }).catch(() => null)
        await db().query("UPDATE generation_jobs SET status='running',phase='provider_submitting',updated_at=now() WHERE id=$1", [jobRow.id]).catch(() => {})
        return true
      }
      await failRunTerminal(run, jobRow, classified.code, classified.diagnostic, classified.code.startsWith('PROMPT_') || classified.code.startsWith('LANGUAGE_') ? 'optimization_failed' : 'generation_failed')
      return true
    }
    const fresh = await getProviderRunById(db(), run.id).catch(() => null)
    if (fresh) run = fresh
    if (result.status === 'waiting') {
      await storeRunWaiting(run, result)
      await db().query("UPDATE generation_jobs SET phase='provider_waiting',updated_at=now() WHERE id=$1", [jobRow.id]).catch(() => {})
      return true
    }
    if (result.status === 'submission_unknown') {
      await storeRunUnknown(run, result)
      await db().query("UPDATE generation_jobs SET phase='provider_submitting',updated_at=now() WHERE id=$1", [jobRow.id]).catch(() => {})
      return true
    }
    if (result.status === 'submitting') {
      await updateProviderRunState(db(), { runId: run.id, expectedStateRevision: run.stateRevision, operationState: 'waiting', remoteId: result.remoteId ?? null, nextActionAt: nextActionAtForRetryAfter(result.retryAfterMs), encryptedStatePayload: encryptOpaqueState(result.opaqueState), encryptedStateKeyId: result.opaqueState ? 'provider-credentials-key-v1' : null, providerAccepted: Boolean(result.remoteId) }).catch(() => null)
      return true
    }
    await handleTerminalResult(run, jobRow, revision, config, result, prompt)
    return true
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'GENERATION_FAILED'
    const temporary = ['PROVIDER_TEMPORARY_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_DOWNLOAD_FAILED', 'PROVIDER_BUSY', 'INPUT_IMAGE_UNAVAILABLE', 'STORAGE_TEMPORARY_ERROR', 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR', 'LANGUAGE_MODEL_RESPONSE_INVALID', 'PROMPT_TEMPLATE_SELECTION_INVALID', 'PROMPT_OUTPUT_INVALID'].includes(code)
    const phase = code.startsWith('PROMPT_TEMPLATE') ? 'template_failed' : code.startsWith('PROMPT_') || code.startsWith('LANGUAGE_') ? 'optimization_failed' : 'generation_failed'
    const providerError = error instanceof ProviderHttpError || error instanceof LanguageModelHttpError ? error.diagnostic as unknown as Record<string, unknown> : null
    const latest = await getLatestProviderRunForJob(db(), String((claimed as Record<string, unknown>).id)).catch(() => null)
    await transaction(async client => {
      if (latest && shouldCreateNewRun(latest.operationState) === false) {
        await updateProviderRunState(client, { runId: latest.id, expectedStateRevision: latest.stateRevision, nextActionAt: nextActionAtForRetryAfter(undefined) }).catch(() => null)
      } else if (latest) {
        await updateProviderRunState(client, { runId: latest.id, expectedStateRevision: latest.stateRevision, operationState: 'failed', error: { code, message: code, retryable: temporary }, releaseCapacity: true, completed: !temporary }).catch(() => null)
      }
      await persistJobFailure(client, {
        jobId: String((claimed as Record<string, unknown>).id),
        promptOptimizationId: ((claimed as Record<string, unknown>).prompt_optimization_id as string) || null,
        phase,
        code,
        retryable: temporary,
        providerError,
      }).catch(() => {})
    }).catch(() => {})
    return true
  }
}

// Legacy image-compat path retained: synchronous generateImages through plugins.
export async function processLegacyImageJob(jobId: string): Promise<boolean> {
  const row = await db().query('SELECT * FROM generation_jobs WHERE id=$1 AND deleted_at IS NULL', [jobId])
  const job = row.rows[0] as Record<string, unknown> | undefined
  if (!job) return true
  const prompt = await preprocessPrompt(job)
  const images = await generateImages({
    adapter: String(job.adapter || 'seedream') as 'openai' | 'seedream',
    vendorModelId: String(job.vendor_model_id || ''),
    baseUrl: (job.provider_base_url as string) || undefined,
    apiKey: await resolveApiKey(job as { provider_credential_id?: string; adapter: string }),
    prompt,
    size: String(job.size || '1024x1024'),
    quality: (job.quality as string) || undefined,
    count: Number(job.count || 1),
    watermark: Boolean(job.watermark),
    inputImages: await loadAndValidateInputImages(String(job.id)),
  })
  const uploaded: UploadedImage[] = []
  for (const image of images) {
    const key = `${String(job.created_by)}/${randomUUID()}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`
    const checksum = createHash('sha256').update(image.data).digest('hex')
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: image.data, ContentType: image.mimeType, Metadata: { checksum } }))
    uploaded.push({ key, image, checksum })
  }
  const persisted = await transaction(async client => persistJobSuccess(client, { jobId: String(job.id), createdBy: String(job.created_by), prompt, uploaded }))
  if (!persisted) await deleteUploadedObjects(uploaded)
  return true
}
