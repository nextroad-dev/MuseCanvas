import type { NextResponse } from 'next/server'
import { MASK_INPUT_ROLE, isUuid, type AgentEditPreparationDTO, type PrepareAgentImageEditRequest } from '@musecanvas/contracts'
import type { AuthedContext } from '../../router/types'
import { fail, mutationOriginValid, ok } from '../../shared/http'
import { defaultImageEditPorts, type ImageEditPorts } from './input-rows'
import { createStableUploadIds, prepareImageEdit } from './prepare'
import { agentCoreEnabled, agentCoreAdmissionReady } from '../agent/feature'

// Row-store primitives and the collaborator bundle now live in `input-rows.ts`
// (see the note there for the cycle this breaks). Re-exported so every existing
// importer of `handlers.ts` keeps its public surface unchanged.
export {
  claimKeyedInputRow,
  defaultImageEditPorts,
  mirrorTableMissing,
  promoteKeyedInputRow,
  resolveImageEditUploadLimits,
  storeReadyInputImage,
  type ImageEditPorts,
  type ImageEditUploadLimits,
  type ReadyInputWrite,
  type SqlClient,
} from './input-rows'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A part rather than a text field. Structural, like the plugin upload reader's. */
const isFilePart = (value: unknown): value is File =>
  !!value && typeof value === 'object' &&
  typeof (value as File).name === 'string' &&
  typeof (value as File).arrayBuffer === 'function'

/**
 * `POST /api/images/edit/preparations` — the Agent-only staging route for a
 * region-select edit.
 *
 * Since 2026-11-19 media generation is an Agent capability only: the direct
 * `POST /api/generations` and `POST /api/images/edit` entry points were removed,
 * and job creation is the shared `@musecanvas/media-service` command invoked by
 * the Agent execution tools. This route therefore stages a source image and a
 * trusted mask for an accepted Agent turn (it never becomes a generation itself):
 * the paid half — approval, then job creation through that shared command —
 * stays in the Agent flow.
 *
 * Two vendor rules shape the work below; both are owned by
 * `packages/providers/src/core/image-edit.ts`, so this route only *decides*, it
 * never re-implements them:
 *
 * 1. the mask is a PNG **with alpha** whose dimensions are **exactly** the source
 *    image's — so the mask is built *after* the real pixel size is known, from the
 *    decoded bytes, never from a declared width and height;
 * 2. a transparent pixel marks what may be regenerated — so a mask without an
 *    alpha channel is refused instead of being resized into a guess that would
 *    silently mean "edit nothing".
 *
 * And the one data-integrity rule this route owns: a gallery source is
 * *referenced*, never mirrored. Writing a `media_uploads` row carrying the asset's
 * own object key would hand that key to the TTL sweep in
 * `apps/worker/src/maintenance/index.ts`, which deletes objects by
 * `media_uploads.object_key` — destroying the user's original artwork because an
 * unrelated temporary input aged out.
 */

export async function prepareAgentImageEdit(context: AuthedContext, ports: ImageEditPorts = defaultImageEditPorts): Promise<NextResponse> {
  const { actor, request } = context
  if (!agentCoreEnabled()) return fail('NOT_FOUND', '接口不存在', 404)
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  // Its own bucket: preparing a mask stages two objects but buys no generation, so it
  // must neither consume nor be starved by the generation allowance.
  if (await ports.limited(`agent:preparation:${actor.id}`, 20, 60)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  let form: FormData
  try { form = await request.formData() } catch { return fail('INVALID_INPUT', '局部修改准备请求必须使用 multipart/form-data 编码') }
  const allowed = new Set<string>(['modelId', 'assetId', 'image', 'region', 'mask', 'idempotencyKey', 'sessionId', 'turnId'] satisfies Array<keyof PrepareAgentImageEditRequest | 'image' | 'mask'>)
  if ([...form.keys()].some(key => !allowed.has(key)) || [...allowed].some(key => form.getAll(key).length > 1))
    return fail('INVALID_INPUT', '局部修改准备请求包含不允许或重复的字段')
  const textField = (name: string) => typeof form.get(name) === 'string' ? String(form.get(name)).trim() : ''
  const modelId = textField('modelId')
  const assetId = textField('assetId')
  const regionText = textField('region')
  const image = isFilePart(form.get('image')) ? form.get('image') as File : undefined
  const maskFile = isFilePart(form.get('mask')) ? form.get('mask') as File : undefined
  const key = textField('idempotencyKey')
  const sessionId = textField('sessionId')
  const turnId = textField('turnId')
  if ((form.has('sessionId') && !isUuid(sessionId)) || (form.has('turnId') && !isUuid(turnId)) || (turnId && !sessionId))
    return fail('INVALID_INPUT', '准备上下文必须使用有效会话与轮次标识')
  if (!UUID_PATTERN.test(modelId) || Boolean(assetId) === Boolean(image) || Boolean(regionText) === Boolean(maskFile) || key.length > 128)
    return fail('INVALID_INPUT', '局部修改准备参数无效')
  if (!turnId && !agentCoreAdmissionReady(actor.id)) return fail('UNAVAILABLE', '暂未开放新的 Agent 任务准备', 503)
  if (sessionId) {
    const scope = await ports.db().query(`SELECT s.id AS preparation_session FROM agent_sessions s
      JOIN users u ON u.id=s.owner_id
      ${turnId ? 'JOIN agent_turns t ON t.session_id=s.id AND t.id=$3 AND s.active_turn_id=t.id' : ''}
      WHERE s.id=$1 AND s.owner_id=$2 AND s.archived_at IS NULL AND u.status='active' AND u.deleted_at IS NULL
      ${turnId ? "AND t.status NOT IN ('completed','failed','cancelled') AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at" : ''}`,
    turnId ? [sessionId, actor.id, turnId] : [sessionId, actor.id])
    if (!scope.rows.length) return fail('NOT_FOUND', '准备上下文不可用', 404)
  }
  // Migration 0045 is what makes a prepared mask trustworthy. Without it the shared
  // command fails mid-staging; refusing first keeps the failure legible and leaves
  // no half-written provenance behind.
  const schema = await ports.db().query(`SELECT to_regclass('public.agent_media_mask_preparations') IS NOT NULL AS present`)
  if (schema.rows[0]?.present !== true) return fail('UNAVAILABLE', '局部修改准备暂不可用', 503)
  const prepared = await prepareImageEdit({ actor, modelId, prompt: '', assetId: assetId || undefined,
    imageBytes: image ? Buffer.from(await image.arrayBuffer()) : undefined, regionText: regionText || undefined,
    maskBytes: maskFile ? Buffer.from(await maskFile.arrayBuffer()) : undefined,
    stableUploadIds: key ? createStableUploadIds(`${actor.id}:agent-preparation:${key}`) : undefined,
    agentPreparation: true, ports })
  if (!prepared.success) return prepared.response
  const maskUploadId = prepared.data.inputs.find(input => input.role === MASK_INPUT_ROLE)?.uploadId
  const source = prepared.data.inputs.find(input => input.role === 'reference_image')
  if (!maskUploadId || !source) return fail('UNAVAILABLE', '局部修改准备失败', 503)
  // The identity's own expiry is the upload's, copied by 0045: report the row, never
  // a locally computed deadline that could disagree with the RLS-free database clock.
  const expiry = await ports.db().query(`SELECT expires_at::text AS expires_at FROM media_uploads
    WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL AND object_deleted_at IS NULL AND clock_timestamp()<expires_at`,
  [maskUploadId, actor.id])
  if (!expiry.rows[0]) return fail('IDEMPOTENCY_CONFLICT', '局部修改准备已过期，请重新选择', 409)
  return ok({ maskUploadId, source: source.uploadId ? { kind: 'upload', id: source.uploadId } : { kind: 'asset', id: source.assetId! },
    sourceChecksum: prepared.data.sourceChecksum, maskChecksum: prepared.data.artifacts.mask.checksum,
    width: prepared.data.source.width, height: prepared.data.source.height, ...(prepared.data.selection ? { selection: prepared.data.selection } : {}),
    expiresAt: String(expiry.rows[0].expires_at), preparationVersion: 1 } satisfies AgentEditPreparationDTO, { status: 202 })
}
