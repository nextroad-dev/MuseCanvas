import { createHash, randomUUID } from 'node:crypto'
import type { NextResponse } from 'next/server'
import {
  buildInpaintPrompt,
  clampEditSelection,
  MASK_INPUT_ROLE,
  MAX_MASK_BYTES,
  MIN_EDIT_SELECTION_PX,
  parseRectangleRegion,
  type EditSelection,
  type GenerationInputItem,
  type ModelCapabilities,
} from '@musecanvas/contracts'
import {
  createEditMask,
  inspectInputImage,
  normalizeAlphaMask,
  pickClosestAllowedSize,
} from '../../../../../packages/providers/src/index'
import type { Actor } from '../../auth/security'
import { capabilitiesFromRow, legacyColumnsFromCapabilities } from '../../shared/dto'
import { fail } from '../../shared/http'
import { ALLOWED_MIME_TYPES } from '../generation-uploads'
import {
  claimKeyedInputRow,
  defaultImageEditPorts,
  type ImageEditPorts,
  mirrorTableMissing,
  promoteKeyedInputRow,
  storeReadyInputImage,
  type ReadyInputWrite,
} from './handlers'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Deterministic upload identity for a keyed idempotent edit.
 *
 * A public `POST /images/edit` retry with the same `Idempotency-Key` must
 * normalize to the *same* input payload, or the shared creation command sees a
 * different mask id and reports a conflict where the caller simply retried.
 * The id is derived from the caller-chosen key plus the artifact checksum, so
 * identical content still shares one upload row while different content (or a
 * different key) derives a different id. Random ids remain the behaviour for
 * keyless requests.
 */
export function createStableUploadIds(seed: string): {
  derive: (purpose: 'source' | 'mask', checksum: string) => string
} {
  return {
    derive: (purpose, checksum) => {
      const digest = createHash('sha1').update(`canvas-edit-staged-upload:${seed}:${purpose}:${checksum}`).digest()
      const bytes = Buffer.from(digest.subarray(0, 16))
      bytes[6] = (bytes[6] & 0x0f) | 0x50 // RFC 4122 version 5
      bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
      const hex = bytes.toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  }
}

function sourceImageFailure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : ''
  if (message === 'INVALID_INPUT_IMAGE_SIZE') return fail('INVALID_INPUT_IMAGE_SIZE', '图片尺寸或大小超出限制', 400)
  return fail('INVALID_INPUT_IMAGE', '源图无效或不受支持，仅支持 PNG 与 JPEG 图片', 400)
}

function maskFailure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : ''
  const code = message.split(':')[0]
  if (code === 'MASK_BYTE_LIMIT_EXCEEDED') {
    return fail('INVALID_INPUT_IMAGE_SIZE', `遮罩文件过大，上限为 ${MAX_MASK_BYTES} 字节`, 400)
  }
  if (code === 'MASK_ALPHA_MISSING' || code === 'MASK_FORMAT_INVALID') {
    return fail('INVALID_INPUT_IMAGE', '遮罩必须是带 alpha 通道的 PNG 图片（透明处即要修改的区域）', 400)
  }
  if (code === 'MASK_TARGET_DIMENSIONS_EXCEEDED') {
    return fail('INVALID_INPUT_IMAGE_SIZE', '图片尺寸过大，无法生成遮罩', 400)
  }
  return fail('INVALID_INPUT_IMAGE', '遮罩无效，请重新框选或重新绘制选区', 400)
}

function stagedObjectKey(actorId: string, uploadId: string, mimeType: string): string {
  return `inputs/${actorId}/${uploadId}.${mimeType === 'image/png' ? 'png' : 'jpg'}`
}

export interface PrepareImageEditInput {
  actor: Actor
  modelId: string
  prompt: string
  parameters?: Record<string, unknown>
  assetId?: string
  imageBytes?: Buffer
  imageMimeType?: string
  regionText?: string
  selection?: EditSelection
  maskBytes?: Buffer
  quality?: string
  ports?: ImageEditPorts
  reservedMask?: { uploadId: string; expiresAt: string; persist: (row: ReadyInputWrite & { sourceChecksum: string }, put: () => Promise<void>) => Promise<void> }
  /** Key-scoped deterministic upload ids so a retried edit derives the same normalized inputs. */
  stableUploadIds?: { derive: (purpose: 'source' | 'mask', checksum: string) => string }
  /** Validate, decode and compute only; write no object and no row (idempotent replay pre-check). */
  dryRun?: boolean
}

export interface PreparedImageEdit {
  model: Record<string, unknown>
  capabilities: ModelCapabilities
  prompt: string
  parameters: Record<string, unknown>
  inputs: GenerationInputItem[]
  source: { width: number; height: number }
  selection?: EditSelection
  sourceChecksum: string
  /** Byte identity of the staged artifacts, used to verify a retry against an existing job. */
  artifacts: {
    source: { checksum: string; width: number; height: number; sizeBytes: number } | null
    mask: { checksum: string; width: number; height: number; sizeBytes: number }
  }
}

function stagingFailure(error: unknown, label: string): NextResponse {
  const message = error instanceof Error ? error.message : ''
  if (message === 'INPUT_ROW_RECLAIMED') return fail('IDEMPOTENCY_CONFLICT', '该请求标识对应的临时输入已过期或被回收，请使用新的请求标识重新发起', 409)
  if (message === 'INPUT_ROW_CONFLICT') return fail('IDEMPOTENCY_CONFLICT', '该请求标识对应的临时输入与本次请求不一致，请使用新的请求标识重新发起', 409)
  return fail('GENERATION_CREATE_FAILED', `${label}存储失败，请稍后重试`, 503)
}

/**
 * A promote rejected by a tombstoned row means the TTL sweep reclaimed the row
 * after our claim but before our PUT landed: that late object no longer has a
 * reclaimable row. Remove it only when nothing references it — a reference
 * means a job attached it during the reclamation race, and that job still needs
 * the bytes.
 */
async function discardLateKeyedObject(ports: ImageEditPorts, uploadId: string, objectKey: string): Promise<void> {
  // Serialize with attach by taking the same media -> legacy row locks, re-check
  // for a committed job reference under those locks, then retire both rows so no
  // later attach can bind them. The reference check and the retirement are one
  // atomic step; the object is removed only after it. A referenced object means
  // a job attached it during the reclamation race and must survive.
  let retiredAt = ''
  const retired = await ports.runTransaction(async client => {
    try {
      await client.query('SELECT id FROM media_uploads WHERE id=$1 FOR UPDATE', [uploadId])
    } catch (error) {
      // Missing generic table on older databases.
      if (!mirrorTableMissing(error)) throw error
    }
    await client.query('SELECT id FROM generation_input_images WHERE id=$1 FOR UPDATE', [uploadId])
    const refs = await client.query('SELECT 1 FROM generation_job_inputs WHERE input_image_id=$1 OR upload_id=$1 LIMIT 1', [uploadId])
    if (refs.rows.length > 0) throw new Error('INPUT_OBJECT_REFERENCED')
    try {
      await client.query("UPDATE media_uploads SET status='deleted', deleted_at=COALESCE(deleted_at, now()), object_deleted_at=NULL, updated_at=now() WHERE id=$1", [uploadId])
    } catch (error) {
      // Missing generic table on older databases.
      if (!mirrorTableMissing(error)) throw error
    }
    // The fence must be the exact database value: a JS Date/string round-trip
    // drops fractional seconds and would never compare equal to the column.
    const marked = await client.query("UPDATE generation_input_images SET status='deleted', deleted_at=COALESCE(deleted_at, now()), object_deleted_at=NULL, updated_at=now() WHERE id=$1 RETURNING updated_at::text AS updated_at", [uploadId])
    retiredAt = String(marked.rows[0]?.updated_at ?? '')
  }).then(() => true).catch(() => false)
  if (!retired || !retiredAt) return
  try {
    await ports.deleteObject(objectKey)
  } catch {
    // Rows stay deleted with object_deleted_at NULL, so the soft-delete sweep
    // picks the object up again after its grace window.
    return
  }
  try {
    await ports.runTransaction(async client => {
      // Fence the success marker to its own retirement: a later late-writer
      // retirement bumped updated_at and may have re-registered a new object, so
      // a stale success must not mark it reclaimed.
      try {
        await client.query("UPDATE media_uploads SET object_deleted_at=now(), updated_at=now() WHERE id=$1 AND status='deleted' AND object_deleted_at IS NULL AND updated_at=$2", [uploadId, retiredAt])
      } catch (error) {
        // Missing generic table on older databases.
        if (!mirrorTableMissing(error)) throw error
      }
      await client.query("UPDATE generation_input_images SET object_deleted_at=now(), updated_at=now() WHERE id=$1 AND status='deleted' AND object_deleted_at IS NULL AND updated_at=$2", [uploadId, retiredAt])
    })
  } catch {
    // A failed marker write leaves object_deleted_at NULL; the sweep retries harmlessly.
  }
}

export type PrepareImageEditResult =
  | { success: true; data: PreparedImageEdit }
  | { success: false; response: NextResponse }

/**
 * Validates, measures and stages artifacts for an image inpainting request.
 * Shared verbatim between direct POST /api/images/edit and Canvas Agent edit_image tool.
 */
export async function prepareImageEdit(input: PrepareImageEditInput): Promise<PrepareImageEditResult> {
  const ports = input.ports ?? defaultImageEditPorts
  const { actor, modelId, prompt, quality, parameters: clientParameters = {} } = input
  const assetId = input.assetId
  const hasImageUpload = input.imageBytes !== undefined
  const regionText = input.regionText
  const selectionInput = input.selection
  const hasMaskUpload = input.maskBytes !== undefined

  if (assetId && hasImageUpload) return { success: false, response: fail('INVALID_INPUT', '源图只能提供 assetId 或 image 文件其中一种') }
  if (!assetId && !hasImageUpload) return { success: false, response: fail('INVALID_INPUT', '缺少源图：请提供 assetId 或 image 文件') }
  if ((regionText || selectionInput) && hasMaskUpload) return { success: false, response: fail('INVALID_INPUT', '选区只能提供 region 矩形或 mask 遮罩文件其中一种') }
  if (!regionText && !selectionInput && !hasMaskUpload) return { success: false, response: fail('INVALID_INPUT', '缺少选区：请提供 region 矩形或 mask 遮罩文件') }
  if (assetId && !UUID_PATTERN.test(assetId)) return { success: false, response: fail('INVALID_INPUT', 'assetId 格式无效') }

  const modelResult = await ports.db().query(
    `SELECT m.*, rev.capabilities, rev.defaults, rev.revision FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.enabled=true AND m.deleted_at IS NULL`,
    [modelId],
  )
  const model = modelResult.rows[0]
  if (!model) return { success: false, response: fail('MODEL_NOT_AVAILABLE', '模型当前不可用', 404) }
  if (String(model.model_kind || '') !== 'image') {
    return { success: false, response: fail('MODEL_NOT_AVAILABLE', '局部修改仅支持图片生成模型', 400) }
  }
  const capabilities = capabilitiesFromRow(model)
  const maskCapable = capabilities.declaredBy !== 'undeclared'
    && capabilities.inputSlots.some(slot => slot.role === MASK_INPUT_ROLE)
  if (!maskCapable) {
    return {
      success: false,
      response: fail(
        'MODEL_MASK_NOT_SUPPORTED',
        '当前模型不支持局部修改（未声明选区遮罩输入），请更换支持局部修改的图片模型',
        409,
        { parameter: 'modelId', value: modelId },
      ),
    }
  }

  const declaredSizes = legacyColumnsFromCapabilities(capabilities).sizes
  const limits = await ports.uploadLimits()

  let source: { width: number; height: number }
  let sourceChecksum: string
  let sourceArtifact: PreparedImageEdit['artifacts']['source'] = null
  let sourceInput: GenerationInputItem
  if (assetId) {
    const owned = await ports.db().query(
      `SELECT id,object_key,media_kind,mime_type,width,height FROM assets
       WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL`,
      [assetId, actor.id],
    )
    const asset = owned.rows[0]
    if (!asset) return { success: false, response: fail('NOT_FOUND', '图库作品不存在或无权访问', 404) }
    if (String(asset.media_kind || 'image') !== 'image' || !ALLOWED_MIME_TYPES[String(asset.mime_type || '')]) {
      return { success: false, response: fail('INVALID_INPUT_IMAGE', '局部修改仅支持 PNG 或 JPEG 图片', 400) }
    }
    let assetBytes: Buffer
    try {
      assetBytes = await ports.readObjectBytes(String(asset.object_key))
    } catch {
      return { success: false, response: fail('INPUT_IMAGE_UNAVAILABLE', '图库作品文件读取失败，请稍后重试', 400) }
    }
    let inspectedSource: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
    try {
      inspectedSource = inspectInputImage(assetBytes, { maxImageBytes: limits.maxImageBytes })
    } catch (error) {
      return { success: false, response: sourceImageFailure(error) }
    }
    if (inspectedSource.mimeType !== String(asset.mime_type || '')) {
      return { success: false, response: fail('INVALID_INPUT_IMAGE', '图库作品的实际格式与其记录不符，无法用于局部修改', 400) }
    }
    sourceChecksum = createHash('sha256').update(assetBytes).digest('hex')
    source = { width: inspectedSource.width, height: inspectedSource.height }
    sourceInput = { assetId: String(asset.id), role: 'reference_image', position: 0 }
  } else {
    const bytes = input.imageBytes!
    if (bytes.length === 0) return { success: false, response: fail('INVALID_INPUT_IMAGE', '源图内容为空', 400) }
    if (bytes.length > limits.maxImageBytes) {
      return { success: false, response: fail('INVALID_INPUT_IMAGE_SIZE', `源图不能超过 ${limits.maxImageBytes} 字节`, 400) }
    }
    let inspectedUpload: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
    try {
      inspectedUpload = inspectInputImage(bytes, { maxImageBytes: limits.maxImageBytes })
    } catch (error) {
      return { success: false, response: sourceImageFailure(error) }
    }
    sourceChecksum = createHash('sha256').update(bytes).digest('hex')
    source = { width: inspectedUpload.width, height: inspectedUpload.height }
    const uploadId = input.stableUploadIds ? input.stableUploadIds.derive('source', sourceChecksum) : randomUUID()
    const objectKey = stagedObjectKey(actor.id, uploadId, inspectedUpload.mimeType)
    const sourceRow: ReadyInputWrite = {
      uploadId,
      actorId: actor.id,
      objectKey,
      mimeType: inspectedUpload.mimeType,
      width: inspectedUpload.width,
      height: inspectedUpload.height,
      sizeBytes: bytes.length,
      checksum: sourceChecksum,
      ttlSeconds: limits.uploadTtlSeconds,
    }
    if (!input.dryRun) {
      let objectWritten = false
      try {
        if (input.stableUploadIds) {
          await ports.runTransaction(async client => { await claimKeyedInputRow(client, sourceRow) })
          await ports.putObjectBytes(objectKey, bytes, inspectedUpload.mimeType)
          objectWritten = true
          await ports.runTransaction(async client => { await promoteKeyedInputRow(client, sourceRow) })
        } else {
          await ports.putObjectBytes(objectKey, bytes, inspectedUpload.mimeType)
          objectWritten = true
          await ports.runTransaction(async client => { await storeReadyInputImage(client, sourceRow) })
        }
      } catch (error) {
        // A keyed object is shared with any concurrent retry of the same key and may
        // already belong to a committed request: never compensating-delete it. The
        // pending row registered above is what lets TTL reclaim a failed attempt;
        // only a promote-rejected tombstone makes our own late PUT unreclaimable.
        if (input.stableUploadIds) {
          if (objectWritten && error instanceof Error && error.message === 'INPUT_ROW_RECLAIMED') {
            await discardLateKeyedObject(ports, sourceRow.uploadId, objectKey)
          }
        } else {
          await ports.deleteObject(objectKey).catch(() => {})
        }
        return { success: false, response: stagingFailure(error, '源图') }
      }
    }
    sourceInput = { uploadId, role: 'reference_image', position: 0 }
    sourceArtifact = { checksum: sourceChecksum, width: inspectedUpload.width, height: inspectedUpload.height, sizeBytes: bytes.length }
  }

  const size = pickClosestAllowedSize(declaredSizes, source.width, source.height)
  if (!size) {
    return { success: false, response: fail('INVALID_INPUT', '该模型未声明可用的输出尺寸，无法为局部修改确定尺寸', 400) }
  }

  let maskBytes: Buffer
  let resolvedSelection: EditSelection | undefined
  if (selectionInput || regionText) {
    let region: { x: number; y: number; width: number; height: number } | null = null
    if (selectionInput) {
      region = selectionInput
    } else {
      let regionJson: unknown
      try {
        regionJson = JSON.parse(regionText!)
      } catch {
        return { success: false, response: fail('INVALID_INPUT', 'region 必须是 {x,y,width,height} 形式的 JSON 对象') }
      }
      const parsedRegion = parseRectangleRegion(regionJson)
      if (!parsedRegion || parsedRegion.type !== 'rectangle') {
        return { success: false, response: fail('INVALID_INPUT', 'region 必须是 {x,y,width,height} 形式的 JSON 对象') }
      }
      region = parsedRegion
    }

    const clamped: EditSelection | null = clampEditSelection(
      { x: region.x, y: region.y, width: region.width, height: region.height },
      source.width,
      source.height,
    )
    if (!clamped) {
      return {
        success: false,
        response: fail(
          'INVALID_INPUT',
          `框选区域无效：必须落在图片（${source.width}×${source.height} 像素）范围内，且不小于 ${MIN_EDIT_SELECTION_PX}×${MIN_EDIT_SELECTION_PX} 像素`,
          400,
          { parameter: 'region', value: regionText ? regionText.slice(0, 200) : JSON.stringify(region) },
        ),
      }
    }
    resolvedSelection = clamped
    try {
      maskBytes = await createEditMask({ imageWidth: source.width, imageHeight: source.height, selection: clamped })
    } catch (error) {
      return { success: false, response: maskFailure(error) }
    }
  } else {
    try {
      maskBytes = await normalizeAlphaMask(input.maskBytes!, source.width, source.height)
    } catch (error) {
      return { success: false, response: maskFailure(error) }
    }
  }

  const maskChecksum = createHash('sha256').update(maskBytes).digest('hex')
  const maskUploadId = input.reservedMask?.uploadId
    ?? (input.stableUploadIds ? input.stableUploadIds.derive('mask', maskChecksum) : randomUUID())
  const maskObjectKey = stagedObjectKey(actor.id, maskUploadId, 'image/png')
  const maskRow: ReadyInputWrite & { sourceChecksum: string } = {
    uploadId: maskUploadId, actorId: actor.id, objectKey: maskObjectKey, mimeType: 'image/png', width: source.width, height: source.height,
    sizeBytes: maskBytes.length, checksum: maskChecksum, ttlSeconds: limits.uploadTtlSeconds,
    sourceChecksum, ...(input.reservedMask ? { expiresAt: input.reservedMask.expiresAt } : {}),
  }
  if (!input.dryRun) {
    let objectWritten = false
    try {
      if (input.reservedMask) {
        if (!ports.putReservedMask) throw new Error('IMMUTABLE_MASK_STORAGE_UNAVAILABLE')
        await input.reservedMask.persist(maskRow, () => ports.putReservedMask!(maskObjectKey, maskBytes))
      } else if (input.stableUploadIds) {
        await ports.runTransaction(async client => { await claimKeyedInputRow(client, maskRow) })
        await ports.putObjectBytes(maskObjectKey, maskBytes, 'image/png')
        objectWritten = true
        await ports.runTransaction(async client => { await promoteKeyedInputRow(client, maskRow) })
      } else {
        await ports.putObjectBytes(maskObjectKey, maskBytes, 'image/png')
        objectWritten = true
        await ports.runTransaction(async client => { await storeReadyInputImage(client, maskRow) })
      }
    } catch (error) {
      // Reserved and keyed objects are never compensating-deleted: another fenced or
      // concurrent owner may already hold them, and the registered row is what lets
      // TTL reclaim a failed keyed attempt. A promote-rejected tombstone is the one
      // case where our own late PUT lost its row, so it is removed explicitly.
      if (input.stableUploadIds) {
        if (objectWritten && error instanceof Error && error.message === 'INPUT_ROW_RECLAIMED') {
          await discardLateKeyedObject(ports, maskRow.uploadId, maskObjectKey)
        }
      } else if (!input.reservedMask) {
        await ports.deleteObject(maskObjectKey).catch(() => {})
      }
      return { success: false, response: stagingFailure(error, '遮罩') }
    }
  }
  const maskInput: GenerationInputItem = { uploadId: maskUploadId, role: MASK_INPUT_ROLE, position: 1 }
  const maskArtifact: PreparedImageEdit['artifacts']['mask'] = { checksum: maskChecksum, width: source.width, height: source.height, sizeBytes: maskBytes.length }

  const parameters: Record<string, unknown> = { ...clientParameters, size }
  if (quality) parameters.quality = quality
  parameters.count = 1

  return {
    success: true,
    data: {
      model,
      capabilities,
      prompt: buildInpaintPrompt(prompt),
      parameters,
      inputs: [sourceInput, maskInput],
      source,
      sourceChecksum,
      selection: resolvedSelection,
      artifacts: { source: sourceArtifact, mask: maskArtifact },
    },
  }
}
