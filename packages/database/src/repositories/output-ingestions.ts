import type pg from 'pg'

export type IngestionState =
  | 'pending'
  | 'downloading'
  | 'uploading'
  | 'verifying'
  | 'persisted'
  | 'failed'

export interface OutputIngestionRow {
  id: string
  job_id: string
  run_id: string
  output_index: number
  media_kind: 'image' | 'video'
  storage_object_key: string
  multipart_upload_id: string | null
  checksum: string | null
  size_bytes: string | number | null
  mime_type: string | null
  ingestion_state: IngestionState
  asset_id: string | null
  metadata: unknown
  error: unknown
  download_started_at: Date | null
  download_completed_at: Date | null
  attached_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface OutputIngestionEntity {
  id: string
  jobId: string
  runId: string
  outputIndex: number
  mediaKind: 'image' | 'video'
  storageObjectKey: string
  multipartUploadId: string | null
  checksum: string | null
  sizeBytes: number | null
  mimeType: string | null
  ingestionState: IngestionState
  assetId: string | null
  metadata: Record<string, unknown>
  error: { code: string; message: string } | null
  downloadStartedAt: string | null
  downloadCompletedAt: string | null
  attachedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toOutputIngestionEntity(row: OutputIngestionRow): OutputIngestionEntity {
  return {
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    outputIndex: Number(row.output_index),
    mediaKind: row.media_kind,
    storageObjectKey: row.storage_object_key,
    multipartUploadId: row.multipart_upload_id ?? null,
    checksum: row.checksum ?? null,
    sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    mimeType: row.mime_type ?? null,
    ingestionState: row.ingestion_state,
    assetId: row.asset_id ?? null,
    metadata: (row.metadata as Record<string, unknown>) || {},
    error: (row.error as { code: string; message: string }) || null,
    downloadStartedAt: row.download_started_at instanceof Date ? row.download_started_at.toISOString() : (row.download_started_at ? String(row.download_started_at) : null),
    downloadCompletedAt: row.download_completed_at instanceof Date ? row.download_completed_at.toISOString() : (row.download_completed_at ? String(row.download_completed_at) : null),
    attachedAt: row.attached_at instanceof Date ? row.attached_at.toISOString() : (row.attached_at ? String(row.attached_at) : null),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

export interface RegisterOutputIngestionInput {
  jobId: string
  runId: string
  outputIndex: number
  mediaKind: 'image' | 'video'
  storageObjectKey: string
  metadata?: Record<string, unknown>
}

export async function registerOutputIngestion(
  client: pg.PoolClient | pg.Pool,
  input: RegisterOutputIngestionInput,
): Promise<OutputIngestionEntity> {
  const res = await client.query(
    `INSERT INTO output_ingestions(
       job_id, run_id, output_index, media_kind, storage_object_key, metadata
     ) VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, output_index) DO UPDATE
       SET storage_object_key = EXCLUDED.storage_object_key,
           metadata = EXCLUDED.metadata,
           updated_at = now()
     RETURNING *`,
    [
      input.jobId,
      input.runId,
      input.outputIndex,
      input.mediaKind,
      input.storageObjectKey,
      JSON.stringify(input.metadata || {}),
    ],
  )
  return toOutputIngestionEntity(res.rows[0] as OutputIngestionRow)
}

export interface UpdateOutputIngestionInput {
  id: string
  ingestionState?: IngestionState
  multipartUploadId?: string | null
  checksum?: string | null
  sizeBytes?: number | null
  mimeType?: string | null
  assetId?: string | null
  error?: { code: string; message: string } | null
  downloadStarted?: boolean
  downloadCompleted?: boolean
  attached?: boolean
}

export async function updateOutputIngestion(
  client: pg.PoolClient | pg.Pool,
  input: UpdateOutputIngestionInput,
): Promise<OutputIngestionEntity | null> {
  const updates: string[] = ['updated_at = now()']
  const values: unknown[] = [input.id]

  if (input.ingestionState !== undefined) {
    values.push(input.ingestionState)
    updates.push(`ingestion_state = $${values.length}`)
  }
  if (input.multipartUploadId !== undefined) {
    values.push(input.multipartUploadId)
    updates.push(`multipart_upload_id = $${values.length}`)
  }
  if (input.checksum !== undefined) {
    values.push(input.checksum)
    updates.push(`checksum = $${values.length}`)
  }
  if (input.sizeBytes !== undefined) {
    values.push(input.sizeBytes)
    updates.push(`size_bytes = $${values.length}`)
  }
  if (input.mimeType !== undefined) {
    values.push(input.mimeType)
    updates.push(`mime_type = $${values.length}`)
  }
  if (input.assetId !== undefined) {
    values.push(input.assetId)
    updates.push(`asset_id = $${values.length}`)
  }
  if (input.error !== undefined) {
    values.push(input.error ? JSON.stringify(input.error) : null)
    updates.push(`error = $${values.length}`)
  }
  if (input.downloadStarted) {
    updates.push('download_started_at = COALESCE(download_started_at, now())')
  }
  if (input.downloadCompleted) {
    updates.push('download_completed_at = COALESCE(download_completed_at, now())')
  }
  if (input.attached) {
    updates.push('attached_at = COALESCE(attached_at, now())')
  }

  const query = `
    UPDATE output_ingestions
    SET ${updates.join(', ')}
    WHERE id = $1
    RETURNING *
  `
  const res = await client.query(query, values)
  if (!res.rows[0]) return null
  return toOutputIngestionEntity(res.rows[0] as OutputIngestionRow)
}

export async function getOutputIngestionsByJob(
  client: pg.PoolClient | pg.Pool,
  jobId: string,
): Promise<OutputIngestionEntity[]> {
  const res = await client.query(
    'SELECT * FROM output_ingestions WHERE job_id = $1 ORDER BY output_index ASC',
    [jobId],
  )
  return res.rows.map(r => toOutputIngestionEntity(r as OutputIngestionRow))
}

export async function getOutputIngestionByRunIndex(
  client: pg.PoolClient | pg.Pool,
  runId: string,
  outputIndex: number,
): Promise<OutputIngestionEntity | null> {
  const res = await client.query(
    'SELECT * FROM output_ingestions WHERE run_id = $1 AND output_index = $2',
    [runId, outputIndex],
  )
  if (!res.rows[0]) return null
  return toOutputIngestionEntity(res.rows[0] as OutputIngestionRow)
}
