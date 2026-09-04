import { GENERATION_UPLOAD_ID_PATTERN, MAX_INPUT_IMAGES, MAX_UPLOAD_TOTAL_BYTES } from './constants'

export class GenerationInputError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'GenerationInputError'
    this.code = code
    this.status = status
  }
}
export type GenerationInputRole = 'prompt_image' | 'reference_image' | 'first_frame' | 'last_frame' | 'source_video' | string

export interface NormalizedGenerationInput {
  uploadId: string
  role: GenerationInputRole
  position: number
}

const KNOWN_INPUT_ROLES: Record<string, true> = {
  prompt_image: true,
  reference_image: true,
  first_frame: true,
  last_frame: true,
  source_video: true,
}

/**
 * Normalize the unified `inputs` payload (`[{uploadId, role, position}]`) while
 * accepting the legacy `inputImageIds` string array as a compatibility path.
 * Legacy ids are mapped to `reference_image` roles in array order.
 */
export function normalizeGenerationInputs(
  inputs: unknown,
  legacyInputImageIds?: unknown,
  fallbackRole = 'reference_image',
): NormalizedGenerationInput[] {
  if (inputs === undefined || inputs === null) {
    if (legacyInputImageIds === undefined || legacyInputImageIds === null) return []
    const legacyIds = validateInputImageIdsSyntax(legacyInputImageIds, Number.MAX_SAFE_INTEGER)
    return legacyIds.map((id, index) => ({ uploadId: id, role: fallbackRole, position: index }))
  }
  if (!Array.isArray(inputs)) {
    throw new GenerationInputError('INVALID_INPUT', 'inputs 必须为数组')
  }
  if (inputs.length > 32) {
    throw new GenerationInputError('INVALID_INPUT', '输入数量超出上限')
  }
  const seen: Record<string, true> = {}
  const normalized: NormalizedGenerationInput[] = inputs.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new GenerationInputError('INVALID_INPUT', '输入项格式无效')
    }
    const record = item as Record<string, unknown>
    const uploadId = record.uploadId
    if (typeof uploadId !== 'string' || !GENERATION_UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new GenerationInputError('INVALID_INPUT', '输入 uploadId 格式无效')
    }
    if (seen[uploadId]) {
      throw new GenerationInputError('INVALID_INPUT', '输入 uploadId 重复')
    }
    seen[uploadId] = true
    const role = typeof record.role === 'string' && record.role.trim() ? record.role.trim() : fallbackRole
    const position = record.position === undefined || record.position === null ? index : Number(record.position)
    if (!Number.isInteger(position) || position < 0 || position >= 32) {
      throw new GenerationInputError('INVALID_INPUT', '输入 position 无效')
    }
    return { uploadId, role, position }
  })
  normalized.sort((a, b) => a.position - b.position)
  return normalized
}

/**
 * Validate normalized inputs against a model's capability input slots.
 * Unknown roles are accepted only when the model declares no slots; otherwise
 * the role must match a declared slot and per-slot min/max counts apply.
 */
export function validateInputsAgainstSlots(
  normalized: NormalizedGenerationInput[],
  slots: { role: string; required?: boolean; minCount?: number; maxCount?: number }[],
): NormalizedGenerationInput[] {
  if (!slots || slots.length === 0) {
    if (normalized.length > MAX_INPUT_IMAGES) {
      throw new GenerationInputError('INVALID_INPUT', '参考图数量超出上限')
    }
    for (const item of normalized) {
      if (!KNOWN_INPUT_ROLES[item.role]) {
        throw new GenerationInputError('INVALID_INPUT', `不支持的输入角色：${item.role}`)
      }
    }
    return normalized
  }
  const byRole: Record<string, NormalizedGenerationInput[]> = {}
  for (const item of normalized) {
    byRole[item.role] = byRole[item.role] || []
    byRole[item.role].push(item)
  }
  for (const slot of slots) {
    const items = byRole[slot.role] || []
    const min = slot.minCount ?? (slot.required ? 1 : 0)
    const max = slot.maxCount ?? MAX_INPUT_IMAGES
    if (items.length < min) {
      throw new GenerationInputError('INVALID_INPUT', `缺少必需的输入：${slot.role}`)
    }
    if (items.length > max) {
      throw new GenerationInputError('INVALID_INPUT', `输入 ${slot.role} 数量超出模型支持上限`)
    }
    delete byRole[slot.role]
  }
  const leftovers = Object.keys(byRole)
  if (leftovers.length > 0) {
    throw new GenerationInputError('INVALID_INPUT', `当前模型不支持输入角色：${leftovers.join(',')}`)
  }
  return normalized
}


export function validateInputImageIdsSyntax(
  inputImageIds: unknown,
  modelMaxInputImages: number
): string[] {
  if (inputImageIds === undefined || inputImageIds === null) return []
  if (!Array.isArray(inputImageIds)) {
    throw new GenerationInputError('INVALID_INPUT', 'inputImageIds 必须为数组')
  }
  if (inputImageIds.length === 0) return []

  if (inputImageIds.length > MAX_INPUT_IMAGES) {
    throw new GenerationInputError('INVALID_INPUT', '参考图数量超出上限')
  }
  if (modelMaxInputImages <= 0) {
    throw new GenerationInputError('MODEL_INPUT_IMAGES_NOT_SUPPORTED', '当前模型不支持参考图输入', 400)
  }
  if (inputImageIds.length > modelMaxInputImages) {
    throw new GenerationInputError('INVALID_INPUT', '参考图数量超出模型支持上限', 400)
  }

  const seen: Record<string, true> = {}
  for (const id of inputImageIds) {
    if (typeof id !== 'string' || !GENERATION_UPLOAD_ID_PATTERN.test(id)) {
      throw new GenerationInputError('INVALID_INPUT', '参考图 ID 格式无效')
    }
    if (seen[id]) {
      throw new GenerationInputError('INVALID_INPUT', '参考图 ID 重复')
    }
    seen[id] = true
  }

  return inputImageIds as string[]
}

export interface UploadAttachLimits {
  maxTotalBytes?: number
}

export async function validateAndAttachGenerationInputs(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  actorId: string,
  jobId: string,
  inputImageIds: string[],
  limits?: UploadAttachLimits,
): Promise<void> {
  if (inputImageIds.length === 0) return

  const result = await client.query(
    `SELECT id, status, size_bytes, expires_at, deleted_at, attached_job_id
     FROM generation_input_images
     WHERE id = ANY($1) AND created_by = $2
     FOR UPDATE`,
    [inputImageIds, actorId]
  )

  if (result.rows.length !== inputImageIds.length) {
    throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图不存在或无权访问')
  }

  const rowsById: Record<string, Record<string, unknown>> = {}
  for (const row of result.rows) {
    rowsById[row.id as string] = row
  }

  let totalBytes = 0
  const now = Date.now()

  for (const id of inputImageIds) {
    const row = rowsById[id]
    if (!row || row.deleted_at !== null || row.status === 'deleted') {
      throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图已被删除')
    }
    if (row.status !== 'ready') {
      throw new GenerationInputError('INVALID_INPUT_IMAGE', '参考图未就绪')
    }
    if (row.attached_job_id !== null && row.attached_job_id !== undefined) {
      throw new GenerationInputError('INVALID_INPUT_IMAGE', '参考图已被其他任务使用')
    }
    const expiresAt = new Date(row.expires_at as string | number | Date).getTime()
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图已过期')
    }
    totalBytes += Number(row.size_bytes || 0)
  }
  if (totalBytes > (limits?.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES)) {
    throw new GenerationInputError('INVALID_INPUT_IMAGE_SIZE', '参考图总大小超出限制')
  }

  for (let i = 0; i < inputImageIds.length; i++) {
    const id = inputImageIds[i]
    await client.query(
      `INSERT INTO generation_job_inputs(job_id, input_image_id, position) VALUES($1, $2, $3)`,
      [jobId, id, i]
    )
    await client.query(
      `UPDATE generation_input_images SET status='attached', attached_job_id=$1, updated_at=now() WHERE id=$2`,
      [jobId, id]
    )
  }
}

/**
 * Role-aware generic attach against `media_uploads` (with legacy
 * `generation_input_images` fallback for rows created before the media_uploads
 * backfill). Persists `upload_id` + `role` linkage; keeps the legacy
 * `input_image_id` column populated for image uploads so older readers keep
 * working. Never stores provider secrets or signed URLs.
 */
export async function validateAndAttachGenerationUploads(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  actorId: string,
  jobId: string,
  normalized: NormalizedGenerationInput[],
  limits?: UploadAttachLimits,
): Promise<void> {
  if (normalized.length === 0) return
  const ids = normalized.map(item => item.uploadId)
  let rows: Record<string, unknown>[] = []
  try {
    const result = await client.query(
      `SELECT id, status, size_bytes, expires_at, deleted_at, attached_job_id, media_kind
       FROM media_uploads
       WHERE id = ANY($1) AND created_by = $2
       FOR UPDATE`,
      [ids, actorId],
    )
    rows = result.rows
  } catch {
    rows = []
  }
  if (rows.length !== ids.length) {
    const found: Record<string, true> = {}
    for (const row of rows) found[String(row.id)] = true
    const missing = ids.filter(id => !found[id])
    const fallback = await client.query(
      `SELECT id, status, size_bytes, expires_at, deleted_at, attached_job_id
       FROM generation_input_images
       WHERE id = ANY($1) AND created_by = $2
       FOR UPDATE`,
      [missing, actorId],
    )
    rows = [...rows, ...fallback.rows.map(row => ({ ...row, media_kind: 'image' }))]
  }
  if (rows.length !== ids.length) {
    throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图不存在或无权访问')
  }
  const rowsById: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    rowsById[row.id as string] = row
  }
  let totalBytes = 0
  const now = Date.now()
  for (const item of normalized) {
    const row = rowsById[item.uploadId]
    if (!row || row.deleted_at !== null || row.status === 'deleted') {
      throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图已被删除')
    }
    if (row.status !== 'ready') {
      throw new GenerationInputError('INVALID_INPUT_IMAGE', '参考图未就绪')
    }
    if (row.attached_job_id !== null && row.attached_job_id !== undefined) {
      throw new GenerationInputError('INVALID_INPUT_IMAGE', '参考图已被其他任务使用')
    }
    const expiresAt = new Date(row.expires_at as string | number | Date).getTime()
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      throw new GenerationInputError('INPUT_IMAGE_UNAVAILABLE', '参考图已过期')
    }
    totalBytes += Number(row.size_bytes || 0)
  }
  if (totalBytes > (limits?.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES)) {
    throw new GenerationInputError('INVALID_INPUT_IMAGE_SIZE', '参考图总大小超出限制')
  }
  for (const item of normalized) {
    const mediaKind = String(rowsById[item.uploadId]?.media_kind || 'image')
    await client.query(
      `INSERT INTO generation_job_inputs(job_id, input_image_id, upload_id, position, role) VALUES($1, $2, $3, $4, $5)`,
      [jobId, mediaKind === 'image' ? item.uploadId : null, item.uploadId, item.position, item.role],
    )
    try {
      await client.query(
        `UPDATE media_uploads SET status='attached', attached_job_id=$1, updated_at=now() WHERE id=$2`,
        [jobId, item.uploadId],
      )
    } catch {
      // media_uploads table may not exist on older databases; legacy update below covers it.
    }
    if (mediaKind === 'image') {
      await client.query(
        `UPDATE generation_input_images SET status='attached', attached_job_id=$1, updated_at=now() WHERE id=$2`,
        [jobId, item.uploadId],
      )
    }
  }
}
