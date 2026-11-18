import { createHash } from 'node:crypto'
import { serializeCanonicalJson } from '@musecanvas/domain'
import type { PreparedGeneration } from './create-job'
import type { SqlClient } from '../ports'
import { MediaServiceError } from '../errors'
import { MAX_INPUT_IMAGE_DIMENSION, MIN_INPUT_IMAGE_DIMENSION, MAX_INPUT_IMAGE_ASPECT_RATIO } from '@musecanvas/providers'

export interface ManagedGenerationInputIdentity {
  id: string
  kind: 'asset' | 'upload'
  role: string
  position: number
  checksum: string
  mediaKind: string
  mimeType: string
  width: number | null
  height: number | null
  sizeBytes: number
}
function refuse(): never { throw new MediaServiceError('INPUT_IMAGE_UNAVAILABLE', '输入身份、状态或尺寸不可用', 409) }

export interface AgentBindingInput { id: string; checksum: string; role: string; position: number; preparationVersion?: number; sourceChecksum?: string }
export interface AgentBindingPrice { pricingRevision: string; amount: string; currency: string }

/**
 * Agent-only strict identity lock, before reservations/effects. Uses managed rows
 * rather than caller checksums. Manual/legacy attachment semantics stay unchanged.
 * Lock order matches shared attach: every media_upload, then every legacy mirror.
 */
export async function lockManagedGenerationInputs(client: SqlClient, prepared: PreparedGeneration,
  bindings: AgentBindingInput[], replayJobId?: string): Promise<ManagedGenerationInputIdentity[]> {
  const inputs = prepared.command.normalizedInputs
  const expected = bindings.map(b => ({ ...b })).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const normalized = inputs.map(item => ({ id: item.uploadId ?? item.assetId!, role: item.role, position: item.position }))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  if (expected.length !== normalized.length || expected.some((b, i) => b.id !== normalized[i].id
    || b.role !== normalized[i].role || b.position !== normalized[i].position)) refuse()
  const uploads = normalized.filter(item => inputs.some(i => i.uploadId === item.id && i.assetId === undefined))
  const assets = normalized.filter(item => !uploads.some(u => u.id === item.id))
  const rows = new Map<string, Record<string, unknown>>()
  if (uploads.length) {
    const locked = await client.query(`SELECT *,clock_timestamp()<expires_at AS unexpired FROM media_uploads
      WHERE id=ANY($1::uuid[]) AND created_by=$2 AND deleted_at IS NULL AND object_deleted_at IS NULL
      ORDER BY id FOR UPDATE`, [uploads.map(i => i.id), prepared.command.ownerId])
    for (const row of locked.rows) rows.set(String(row.id), row)
  }
  const mirrors = new Map<string, Record<string, unknown>>()
  if (uploads.some(item => rows.get(item.id)?.media_kind === 'image')) {
    const ids = uploads.filter(item => rows.get(item.id)?.media_kind === 'image').map(i => i.id)
    const locked = await client.query(`SELECT * FROM generation_input_images WHERE id=ANY($1::uuid[]) AND created_by=$2
      AND deleted_at IS NULL AND object_deleted_at IS NULL ORDER BY id FOR UPDATE`, [ids, prepared.command.ownerId])
    for (const row of locked.rows) mirrors.set(String(row.id), row)
  }
  if (assets.length) {
    const locked = await client.query(`SELECT * FROM assets WHERE id=ANY($1::uuid[]) AND created_by=$2
      AND deleted_at IS NULL ORDER BY id FOR SHARE`, [assets.map(i => i.id), prepared.command.ownerId])
    for (const row of locked.rows) rows.set(String(row.id), row)
  }
  const identities: ManagedGenerationInputIdentity[] = []
  let total = 0
  for (const item of normalized) {
    const upload = uploads.some(u => u.id === item.id)
    const row = rows.get(item.id)
    if (!row || typeof row.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(row.checksum)) refuse()
    if (upload) {
      if (!(row.status === 'ready' && row.attached_job_id == null && row.unexpired === true)
        && !(replayJobId && row.status === 'attached' && row.attached_job_id === replayJobId)) refuse()
      if (row.media_kind === 'image') {
        const mirror = mirrors.get(item.id)
        if (!mirror || mirror.checksum !== row.checksum || mirror.mime_type !== row.mime_type
          || mirror.width !== row.width || mirror.height !== row.height || mirror.size_bytes !== row.size_bytes
          || mirror.status !== row.status || mirror.attached_job_id !== row.attached_job_id) refuse()
      }
    }
    const width = row.width == null ? null : Number(row.width)
    const height = row.height == null ? null : Number(row.height)
    if (item.role === 'source_video') {
      if (row.media_kind !== 'video' || typeof row.mime_type !== 'string' || !row.mime_type.startsWith('video/')) refuse()
    } else {
      if (row.media_kind !== 'image' || !['image/png', 'image/jpeg'].includes(String(row.mime_type))) refuse()
      if (!Number.isInteger(width) || !Number.isInteger(height) || width! < MIN_INPUT_IMAGE_DIMENSION || height! < MIN_INPUT_IMAGE_DIMENSION
        || width! > MAX_INPUT_IMAGE_DIMENSION || height! > MAX_INPUT_IMAGE_DIMENSION
        || Math.max(width! / height!, height! / width!) > MAX_INPUT_IMAGE_ASPECT_RATIO) refuse()
    }
    const sizeBytes = Number(row.size_bytes)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > prepared.runtimeLimits.maxImageBytes) refuse()
    total += sizeBytes
    identities.push({ id: item.id, kind: upload ? 'upload' : 'asset', role: item.role, position: item.position,
      checksum: String(row.checksum), mediaKind: String(row.media_kind), mimeType: String(row.mime_type), width, height, sizeBytes })
    const bound = expected.find(b => b.id === item.id)
    if (!bound || bound.checksum !== row.checksum) refuse()
  }
  if (total > prepared.runtimeLimits.maxTotalBytes) refuse()
  if (prepared.command.intendedMode === 'inpaint') {
    const source = identities.find(i => i.role === 'reference_image')
    const mask = identities.find(i => i.role === 'mask')
    if (identities.length !== 2 || !source || !mask || mask.kind !== 'upload' || mask.mimeType !== 'image/png'
      || source.width !== mask.width || source.height !== mask.height) refuse()
    const trusted = (await client.query(`SELECT p.owner_id,p.source_checksum,p.mask_checksum,p.width,p.height,p.preparation_version
      FROM agent_media_mask_preparations p JOIN media_uploads u ON u.id=p.upload_id AND u.created_by=p.owner_id
      WHERE p.upload_id=$1 AND p.owner_id=$2 AND p.source_checksum=$3 AND p.mask_checksum=$4
        AND p.width=$5 AND p.height=$6 AND p.preparation_version=1
        AND (u.status='ready' OR (u.status='attached' AND u.attached_job_id=$7::uuid)) AND u.deleted_at IS NULL AND u.object_deleted_at IS NULL
        AND clock_timestamp()<p.expires_at AND clock_timestamp()<u.expires_at FOR SHARE OF p,u`,
    [mask.id, prepared.command.ownerId, source.checksum, mask.checksum, source.width, source.height, replayJobId ?? null])).rows[0]
    const maskBinding = expected.find(b => b.id === mask.id)
    if (!trusted || maskBinding?.preparationVersion !== 1 || maskBinding.sourceChecksum !== source.checksum) refuse()
  }
  return identities.sort((a, b) => a.position - b.position)
}

/** Exact approved payload M5 hashes into `agent_approvals.arguments_hash`. */
export function generationEffectBindingHash(prepared: PreparedGeneration, inputs: AgentBindingInput[],
  price: AgentBindingPrice, modelRevisionId: string): string {
  return createHash('sha256').update(serializeCanonicalJson({ modelId: prepared.snapshot.frozenPayload.modelId,
    modelRevisionId, prompt: prepared.snapshot.frozenPayload.prompt, parameters: prepared.snapshot.frozenPayload.parameters,
    inputs: prepared.snapshot.frozenPayload.inputs,
    inputBindings: [...inputs].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)), pricing: price })).digest('hex')
}
