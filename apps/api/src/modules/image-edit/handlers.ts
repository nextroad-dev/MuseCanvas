import { randomUUID } from 'node:crypto'
import type { NextResponse } from 'next/server'
import { MASK_INPUT_ROLE } from '@musecanvas/contracts'
import type { AuthedContext } from '../../router/types'
import { fail } from '../../shared/http'
import { defaultImageEditPorts, type ImageEditPorts } from './input-rows'
import { createStableUploadIds, prepareImageEdit, type PreparedImageEdit } from './prepare'

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

/**
 * `POST /api/images/edit` — 局部框选修改图片 (region-select inpainting).
 *
 * Everything on this route is about the *shape of a multipart body*, which no
 * other endpoint has: the source image arrives either as a gallery `assetId` or as
 * raw PNG/JPEG bytes, and the edit region either as a pixel-space `region`
 * rectangle or as an alpha `mask` PNG. What happens once those are settled — the
 * model snapshot, the credential check, the descriptor validation, the job row,
 * the input attach and the outbox event — is the shared creation contract in
 * `generations/create-job.ts`, so an edit can never drift from a plain generation
 * on any of those guarantees. The response is the same 202 plus job DTO, which is
 * why polling, history and the library need no changes for this feature.
 *
 * Two vendor rules shape the order of the code below; both are owned by
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

/** The body's whole vocabulary. Any other key is one this route has no meaning for. */
const ALLOWED_EDIT_FIELDS = [
  'modelId',
  'prompt',
  'assetId',
  'image',
  'region',
  'mask',
  'quality',
  'parameters',
  'idempotencyKey',
] as const

const ALLOWED_EDIT_FIELD_SET = new Set<string>(ALLOWED_EDIT_FIELDS)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const hasControlChars = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) || 0
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

/** A part rather than a text field. Structural, like the plugin upload reader's. */
const isFilePart = (value: unknown): value is File =>
  !!value && typeof value === 'object' &&
  typeof (value as File).name === 'string' &&
  typeof (value as File).arrayBuffer === 'function'

/** The body, read as exactly one value per allowed field — or the response that refused it. */
type EditForm =
  | { ok: true; fields: Record<string, FormDataEntryValue | undefined> }
  | { ok: false; response: NextResponse }

/**
 * `getAll` on every field: a repeated `image` or `mask` part would otherwise
 * smuggle a second artifact that never gets decoded, hashed or attached, and a
 * repeated text field would leave the winning value up to form ordering.
 */
function readEditForm(form: FormData): EditForm {
  const unexpected = [...form.keys()].filter(key => !ALLOWED_EDIT_FIELD_SET.has(key))
  if (unexpected.length > 0) {
    return { ok: false, response: fail('INVALID_INPUT', `局部修改请求包含不允许的字段：${unexpected.join(', ')}`) }
  }
  const fields: Record<string, FormDataEntryValue | undefined> = {}
  for (const key of ALLOWED_EDIT_FIELDS) {
    const values = form.getAll(key)
    if (values.length > 1) {
      return { ok: false, response: fail('INVALID_INPUT', `${key} 字段只能出现一次`) }
    }
    fields[key] = values[0]
  }
  return { ok: true, fields }
}

const textOf = (fields: Record<string, FormDataEntryValue | undefined>, name: string): string =>
  typeof fields[name] === 'string' ? (fields[name] as string).trim() : ''

interface StoredInput { uploadId?: string; assetId?: string; role: string; position: number }

function parseStoredInputs(value: unknown): StoredInput[] | null {
  if (!Array.isArray(value)) return null
  const inputs: StoredInput[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role : ''
    const position = Number(record.position)
    const uploadId = typeof record.uploadId === 'string' ? record.uploadId : undefined
    const assetId = typeof record.assetId === 'string' ? record.assetId : undefined
    if (!role || !Number.isInteger(position) || (uploadId ? Boolean(assetId) : !assetId)) return null
    inputs.push({ ...(uploadId ? { uploadId } : { assetId: assetId as string }), role, position })
  }
  return inputs
}

async function readStoredArtifact(
  ports: ImageEditPorts,
  actorId: string,
  uploadId: string,
): Promise<{ checksum: string; width: number; height: number; sizeBytes: number } | null> {
  const select = async (table: 'generation_input_images' | 'media_uploads') => {
    try {
      return await ports.db().query(`SELECT checksum, width, height, size_bytes FROM ${table} WHERE id=$1 AND created_by=$2`, [uploadId, actorId])
    } catch {
      return { rows: [] as Record<string, unknown>[] }
    }
  }
  const row = (await select('generation_input_images')).rows[0] ?? (await select('media_uploads')).rows[0]
  if (!row) return null
  const checksum = String(row.checksum ?? '')
  const width = Number(row.width)
  const height = Number(row.height)
  const sizeBytes = Number(row.size_bytes)
  if (!/^[0-9a-f]{64}$/.test(checksum) || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(sizeBytes)) return null
  return { checksum, width, height, sizeBytes }
}

/**
 * Map a retry onto the frozen inputs of an existing job. Only identical bytes
 * reuse a stored reference, so a pre-keyed job's random upload ids keep
 * replaying; a changed source/selection stays a conflict decided by the shared
 * creation command (which compares the full normalized payload), never a
 * silent replay and never a rewrite of the job.
 */
async function reuseStoredInputs(
  ports: ImageEditPorts,
  actorId: string,
  storedPayload: Record<string, unknown>,
  computed: PreparedImageEdit,
): Promise<StoredInput[] | null> {
  const stored = parseStoredInputs(storedPayload.inputs)
  if (!stored || stored.length !== computed.inputs.length) return null
  const byKey = new Map(computed.inputs.map(input => [`${input.role}:${input.position}`, input]))
  for (const item of stored) {
    const match = byKey.get(`${item.role}:${item.position}`)
    if (!match) return null
    if (item.assetId || match.assetId) {
      if (!item.assetId || !match.assetId || item.assetId !== match.assetId) return null
      continue
    }
    if (!item.uploadId || !match.uploadId) return null
    const artifact = item.role === MASK_INPUT_ROLE ? computed.artifacts.mask : computed.artifacts.source
    if (!artifact) return null
    const row = await readStoredArtifact(ports, actorId, item.uploadId)
    if (!row || row.checksum !== artifact.checksum || row.width !== artifact.width || row.height !== artifact.height || row.sizeBytes !== artifact.sizeBytes) return null
  }
  return stored
}

export async function editImage(
  context: AuthedContext,
  ports: ImageEditPorts = defaultImageEditPorts,
): Promise<NextResponse> {
  const { actor, request } = context

  // First, before any parsing: the same bucket, budget and position as
  // `POST /api/generations`, because this *is* a generation. An edit that skipped
  // the check would simply be a way to buy extra rate with a different URL.
  if (await ports.limited(`gen:create:${actor.id}`, 20, 300)) {
    return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail('INVALID_INPUT', '局部修改请求必须使用 multipart/form-data 编码')
  }
  const parsed = readEditForm(form)
  if (!parsed.ok) return parsed.response
  const { fields } = parsed

  const modelId = textOf(fields, 'modelId')
  const prompt = typeof fields.prompt === 'string' ? fields.prompt : ''
  if (!UUID_PATTERN.test(modelId)) return fail('INVALID_INPUT', '模型参数无效')
  // `create.ts`'s sanity rules, verbatim: same prompt field of the same job,
  // arriving in a different container.
  if (prompt.trim().length < 1 || prompt.length > 4000 || hasControlChars(prompt)) {
    return fail('INVALID_INPUT', '生成参数无效')
  }

  const assetId = textOf(fields, 'assetId')
  const regionText = textOf(fields, 'region')
  const quality = textOf(fields, 'quality')
  // The unified `parameters` object, mirroring `POST /api/generations`. Every
  // control the model declares — `background`, `output_format`, `input_fidelity`,
  // whatever a future plugin adds — rides here, so an edit never silently drops a
  // choice the console is still showing. Anything the model did not declare is
  // refused by `createGenerationJob`'s descriptor gate, so widening this field
  // does not widen what is accepted. Parsed before any storage work for the same
  // reason the model is read early: a malformed body must not leave an object in
  // the bucket. `size` and `count` are overwritten further down regardless.
  let clientParameters: Record<string, unknown> = {}
  const parametersText = textOf(fields, 'parameters')
  if (parametersText) {
    let parsedParameters: unknown
    try {
      parsedParameters = JSON.parse(parametersText)
    } catch {
      return fail('INVALID_INPUT', 'parameters 必须是合法的 JSON 对象')
    }
    if (typeof parsedParameters !== 'object' || parsedParameters === null || Array.isArray(parsedParameters)) {
      return fail('INVALID_INPUT', 'parameters 必须是 JSON 对象')
    }
    clientParameters = parsedParameters as Record<string, unknown>
  }
  const imagePart = isFilePart(fields.image) ? fields.image : undefined
  const maskPart = isFilePart(fields.mask) ? fields.mask : undefined

  const imageBytes = imagePart ? Buffer.from(await imagePart.arrayBuffer()) : undefined
  const maskBytes = maskPart ? Buffer.from(await maskPart.arrayBuffer()) : undefined

  const explicitKey = request.headers.get('idempotency-key') || textOf(fields, 'idempotencyKey')
  // The explicit key makes the staged artifacts deterministic; a keyless request
  // keeps the old fresh-uuid behaviour and therefore the old "every call is a new
  // generation" semantics.
  const stableUploadIds = explicitKey ? createStableUploadIds(`${actor.id}:${explicitKey}`) : undefined
  const prepareInput = {
    actor,
    modelId,
    prompt,
    parameters: clientParameters,
    assetId: assetId || undefined,
    imageBytes,
    regionText: regionText || undefined,
    maskBytes,
    quality: quality || undefined,
    ports,
    stableUploadIds,
  }

  if (explicitKey) {
    // A duplicate key is a retry, not a second generation. Resolve it through the
    // same shared creation command so the frozen payload decides replay-vs-conflict;
    // computing the retry's payload without writing also keeps a conflicting
    // request from leaving an orphan mask behind. Jobs created before keyed
    // staging existed carry random upload ids, so their frozen inputs are reused
    // only after the retry's bytes have been verified against the stored ones.
    const existing = await ports.db().query(
      'SELECT id, normalized_request FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2',
      [actor.id, explicitKey],
    )
    const existingRow = existing.rows[0]
    if (existingRow) {
      const computed = await prepareImageEdit({ ...prepareInput, dryRun: true })
      if (!computed.success) return computed.response
      const storedPayload = existingRow.normalized_request
      const inputs = storedPayload && typeof storedPayload === 'object' && !Array.isArray(storedPayload)
        ? await reuseStoredInputs(ports, actor.id, storedPayload as Record<string, unknown>, computed.data)
        : null
      if (!inputs) return fail('IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的生成内容', 409)
      return ports.createJob({
        actor,
        modelId,
        prompt: computed.data.prompt,
        parameters: computed.data.parameters,
        normalizedInputs: inputs,
        idempotencyKey: explicitKey,
      })
    }
  }

  const prepared = await prepareImageEdit(prepareInput)
  if (!prepared.success) return prepared.response

  return ports.createJob({
    actor,
    modelId,
    prompt: prepared.data.prompt,
    parameters: prepared.data.parameters,
    normalizedInputs: prepared.data.inputs,
    idempotencyKey: explicitKey || randomUUID(),
  })
}
