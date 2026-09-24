import { createHash, randomUUID } from 'node:crypto'
import type { NextResponse } from 'next/server'
import {
  buildInpaintPrompt,
  clampEditSelection,
  MASK_INPUT_ROLE,
  MAX_MASK_BYTES,
  MIN_EDIT_SELECTION_PX,
  parseRectangleRegion,
  RUNTIME_SETTINGS_DEFAULTS,
  type EditSelection,
  type GenerationInputItem,
} from '@musecanvas/contracts'
import {
  createEditMask,
  inspectInputImage,
  normalizeAlphaMask,
  pickClosestAllowedSize,
} from '../../../../../packages/providers/src/index'
import { db, transaction } from '../../../../../packages/database/src/index'
import type { AuthedContext } from '../../router/types'
import { capabilitiesFromRow, legacyColumnsFromCapabilities } from '../../shared/dto'
import { fail } from '../../shared/http'
import { limited } from '../../shared/redis'
import {
  deleteS3Object,
  getPrivateS3ObjectBytes,
  putPrivateS3ObjectBytes,
} from '../../shared/services'
import { ALLOWED_MIME_TYPES, GENERATION_UPLOAD_TTL_SECONDS } from '../generation-uploads'
import { resolveRuntimeSettings } from '../settings/runtime'
import { createGenerationJob, type CreateGenerationJobCommand } from '../generations/create-job'

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

/** Minimal pg surface this route touches, so every branch is testable against a stub. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface ImageEditUploadLimits {
  maxImageBytes: number
  uploadTtlSeconds: number
}

/**
 * The collaborators `editImage` needs. Production wiring is `defaultImageEditPorts`;
 * a test passes stubs. The seam exists because the promises worth asserting here —
 * "no object was written", "the row says `ready` with *this* checksum", "the count
 * is 1" — are only observable against an injected boundary, and this repo's runner
 * has no module mocking.
 */
export interface ImageEditPorts {
  db: () => SqlClient
  runTransaction: (fn: (client: SqlClient) => Promise<void>) => Promise<void>
  limited: (key: string, max: number, seconds: number) => Promise<boolean>
  readObjectBytes: (objectKey: string) => Promise<Buffer>
  putObjectBytes: (objectKey: string, bytes: Buffer, contentType: string) => Promise<void>
  deleteObject: (objectKey: string) => Promise<void>
  uploadLimits: () => Promise<ImageEditUploadLimits>
  createJob: (cmd: CreateGenerationJobCommand) => Promise<NextResponse>
}

/** Runtime settings first, canonical defaults last — the same resolution order the upload routes use. */
export async function resolveImageEditUploadLimits(): Promise<ImageEditUploadLimits> {
  try {
    const runtime = await resolveRuntimeSettings()
    return { maxImageBytes: runtime.maxImageBytes, uploadTtlSeconds: runtime.uploadTtlSeconds }
  } catch {
    return {
      maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
      uploadTtlSeconds: GENERATION_UPLOAD_TTL_SECONDS,
    }
  }
}

export const defaultImageEditPorts: ImageEditPorts = {
  db: () => db(),
  runTransaction: fn => transaction(async client => { await fn(client) }),
  limited,
  readObjectBytes: objectKey => getPrivateS3ObjectBytes(objectKey),
  putObjectBytes: (objectKey, bytes, contentType) => putPrivateS3ObjectBytes(objectKey, bytes, contentType),
  deleteObject: objectKey => deleteS3Object(objectKey),
  uploadLimits: resolveImageEditUploadLimits,
  createJob: cmd => createGenerationJob(cmd),
}

/** A row created already in `ready` state: geometry, digest and length of the exact bytes in the bucket. */
export interface ReadyInputWrite {
  uploadId: string
  actorId: string
  objectKey: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  checksum: string
  ttlSeconds: number
}

/**
 * Write the dual input row (`generation_input_images` plus its `media_uploads`
 * mirror) for bytes that are already stored, straight into `ready`.
 *
 * The presigned flow creates `pending` first and completes it after the browser's
 * direct PUT; here the server holds the bytes itself, so there is no un-uploaded
 * window to model. `ready` is what `attachGenerationInputs` demands, and
 * `size_bytes`, `mime_type` and `checksum` must describe the exact stored object
 * because `apps/worker/src/jobs/index.ts` re-derives all three after fetching it
 * and fails the job when they disagree. The mirror keeps the same best-effort
 * `try` every other writer here uses, for databases that predate the table.
 */
export async function storeReadyInputImage(client: SqlClient, row: ReadyInputWrite): Promise<void> {
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, 'ready', $3, $4, $5, $6, $7, $8, now() + ($9 * interval '1 second'))`,
    [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds]
  )
  try {
    await client.query(
      `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
       VALUES($1, $2, 'image', 'ready', $3, $4, $5, $6, $7, $8, now() + ($9 * interval '1 second')) ON CONFLICT (id) DO NOTHING`,
      [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds]
    )
  } catch {
    // media_uploads table may not exist on older databases; the legacy row stays source of truth.
  }
}

/** Object key for a server-staged input: the same `inputs/…` namespace the presigned path uses. */
function stagedObjectKey(actorId: string, uploadId: string, mimeType: string): string {
  return `inputs/${actorId}/${uploadId}.${mimeType === 'image/png' ? 'png' : 'jpg'}`
}

/** Byte-length and dimension failures from `inspectInputImage`, coded the way the upload route codes them. */
function sourceImageFailure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : ''
  if (message === 'INVALID_INPUT_IMAGE_SIZE') return fail('INVALID_INPUT_IMAGE_SIZE', '图片尺寸或大小超出限制', 400)
  return fail('INVALID_INPUT_IMAGE', '源图无效或不受支持，仅支持 PNG 与 JPEG 图片', 400)
}

/** A mask failure from `normalizeAlphaMask` / `createEditMask`: readable and Chinese, never a raw vendor dump. */
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
  if (assetId && imagePart) return fail('INVALID_INPUT', '源图只能提供 assetId 或 image 文件其中一种')
  if (!assetId && !imagePart) return fail('INVALID_INPUT', '缺少源图：请提供 assetId 或 image 文件')
  if (regionText && maskPart) return fail('INVALID_INPUT', '选区只能提供 region 矩形或 mask 遮罩文件其中一种')
  if (!regionText && !maskPart) return fail('INVALID_INPUT', '缺少选区：请提供 region 矩形或 mask 遮罩文件')
  if (assetId && !UUID_PATTERN.test(assetId)) return fail('INVALID_INPUT', 'assetId 格式无效')

  // The model decides whether a mask is even accepted and which `size` is legal, so
  // it is read ahead of any storage work: a refusal here must not leave an object
  // in the bucket or an input row behind.
  const modelResult = await ports.db().query(
    `SELECT m.*, rev.capabilities, rev.defaults, rev.revision FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.enabled=true AND m.deleted_at IS NULL`,
    [modelId],
  )
  const model = modelResult.rows[0]
  if (!model) return fail('MODEL_NOT_AVAILABLE', '模型当前不可用', 404)
  if (String(model.model_kind || '') !== 'image') {
    return fail('MODEL_NOT_AVAILABLE', '局部修改仅支持图片生成模型', 400)
  }
  const capabilities = capabilitiesFromRow(model)
  // The server-side twin of a greyed-out button. An undeclared contract is not a
  // permissive one, and a model with no `mask` slot has never been able to take an
  // edit region — leaving it to `createGenerationJob` would answer minutes later
  // with an opaque `UNKNOWN_INPUT_ROLE` on a job the user already trusted.
  const maskCapable = capabilities.declaredBy !== 'undeclared'
    && capabilities.inputSlots.some(slot => slot.role === MASK_INPUT_ROLE)
  if (!maskCapable) {
    return fail(
      'MODEL_MASK_NOT_SUPPORTED',
      '当前模型不支持局部修改（未声明选区遮罩输入），请更换支持局部修改的图片模型',
      409,
      { parameter: 'modelId', value: modelId },
    )
  }
  // `size` is derived from the source image's geometry, so the declared options have
  // to exist for the request to be answerable at all. The helper is the same one
  // the model DTOs use: an `image-size` descriptor answers with its presets, an
  // `enum` one with its option values, and both keep this route off the deprecated
  // flat `model_configs.sizes` column.
  const declaredSizes = legacyColumnsFromCapabilities(capabilities).sizes
  const limits = await ports.uploadLimits()

  // --- the source image -----------------------------------------------------
  let source: { width: number; height: number }
  let sourceInput: GenerationInputItem
  if (assetId) {
    // Ownership is the library predicate, so a picker can never hand over another
    // user's image, and a soft-deleted one is no longer a source.
    const owned = await ports.db().query(
      `SELECT id,object_key,media_kind,mime_type,width,height FROM assets
       WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL`,
      [assetId, actor.id],
    )
    const asset = owned.rows[0]
    if (!asset) return fail('NOT_FOUND', '图库作品不存在或无权访问', 404)
    // Only PNG and JPEG bytes survive the worker's `inspectInputImage`, so only
    // those can be sent to a vendor at all — say it here, in a form error.
    if (String(asset.media_kind || 'image') !== 'image' || !ALLOWED_MIME_TYPES[String(asset.mime_type || '')]) {
      return fail('INVALID_INPUT_IMAGE', '局部修改仅支持 PNG 或 JPEG 图片', 400)
    }
    let assetBytes: Buffer
    try {
      assetBytes = await ports.readObjectBytes(String(asset.object_key))
    } catch {
      return fail('INPUT_IMAGE_UNAVAILABLE', '图库作品文件读取失败，请稍后重试', 400)
    }
    let inspectedSource: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
    try {
      // The *decoded* dimensions, not `assets.width`: the mask is built from these,
      // and a stored value that ever disagreed with the bytes would produce a mask
      // the vendor rejects — worse, one that edits the wrong pixels.
      inspectedSource = inspectInputImage(assetBytes, { maxImageBytes: limits.maxImageBytes })
    } catch (error) {
      return sourceImageFailure(error)
    }
    // The worker re-checks the object it fetches against the row it joins on, so a
    // mismatch here is a job that fails minutes later on a vendor error nobody read.
    if (inspectedSource.mimeType !== String(asset.mime_type || '')) {
      return fail('INVALID_INPUT_IMAGE', '图库作品的实际格式与其记录不符，无法用于局部修改', 400)
    }
    source = { width: inspectedSource.width, height: inspectedSource.height }
    // Referenced, not mirrored: no upload row, and never the asset's object key in
    // one — see the module comment.
    sourceInput = { assetId: String(asset.id), role: 'reference_image', position: 0 }
  } else {
    const bytes = Buffer.from(await imagePart!.arrayBuffer())
    if (bytes.length === 0) return fail('INVALID_INPUT_IMAGE', '源图内容为空', 400)
    if (bytes.length > limits.maxImageBytes) {
      return fail('INVALID_INPUT_IMAGE_SIZE', `源图不能超过 ${limits.maxImageBytes} 字节`, 400)
    }
    // The mime type is what the bytes decode as, not what the part declared: the
    // row and the worker's re-check must agree, and the browser is not authoritative.
    let inspectedUpload: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
    try {
      inspectedUpload = inspectInputImage(bytes, { maxImageBytes: limits.maxImageBytes })
    } catch (error) {
      return sourceImageFailure(error)
    }
    source = { width: inspectedUpload.width, height: inspectedUpload.height }
    const uploadId = randomUUID()
    const objectKey = stagedObjectKey(actor.id, uploadId, inspectedUpload.mimeType)
    try {
      await ports.putObjectBytes(objectKey, bytes, inspectedUpload.mimeType)
      await ports.runTransaction(async client => {
        await storeReadyInputImage(client, {
          uploadId,
          actorId: actor.id,
          objectKey,
          mimeType: inspectedUpload.mimeType,
          width: inspectedUpload.width,
          height: inspectedUpload.height,
          sizeBytes: bytes.length,
          checksum: createHash('sha256').update(bytes).digest('hex'),
          ttlSeconds: limits.uploadTtlSeconds,
        })
      })
    } catch {
      // Chosen failure mode, same as the plugin install path: best-effort
      // compensating delete. An orphaned key in a private bucket is an acceptable
      // cost; a `ready` row pointing at bytes that never landed is not.
      await ports.deleteObject(objectKey).catch(() => { /* orphan accepted */ })
      return fail('GENERATION_CREATE_FAILED', '源图存储失败，请稍后重试', 503)
    }
    sourceInput = { uploadId, role: 'reference_image', position: 0 }
  }

  // An edit of a full-size photo almost never lands on one of the model's fixed
  // sizes, so the declared option nearest the source's aspect ratio is chosen —
  // instead of the model's default, and instead of an illegal literal. Derived
  // before the mask is built: a model that offers nothing legal here is a refusal
  // the user should get *before* the server paid for a rasterised mask.
  const size = pickClosestAllowedSize(declaredSizes, source.width, source.height)
  if (!size) {
    return fail('INVALID_INPUT', '该模型未声明可用的输出尺寸，无法为局部修改确定尺寸', 400)
  }

  // --- the edit region ------------------------------------------------------
  let maskBytes: Buffer
  if (regionText) {
    let regionJson: unknown
    try {
      regionJson = JSON.parse(regionText)
    } catch {
      return fail('INVALID_INPUT', 'region 必须是 {x,y,width,height} 形式的 JSON 对象')
    }
    const region = parseRectangleRegion(regionJson)
    if (!region || region.type !== 'rectangle') {
      return fail('INVALID_INPUT', 'region 必须是 {x,y,width,height} 形式的 JSON 对象')
    }
    // Clamped rather than trusted: a rectangle hanging off the edge is a visible
    // mistake, and a sub-`MIN_EDIT_SELECTION_PX` slip of the mouse would otherwise
    // quietly regenerate almost nothing while reporting a completed edit.
    const selection: EditSelection | null = clampEditSelection(
      { x: region.x, y: region.y, width: region.width, height: region.height },
      source.width,
      source.height,
    )
    if (!selection) {
      return fail(
        'INVALID_INPUT',
        `框选区域无效：必须落在图片（${source.width}×${source.height} 像素）范围内，且不小于 ${MIN_EDIT_SELECTION_PX}×${MIN_EDIT_SELECTION_PX} 像素`,
        400,
        { parameter: 'region', value: regionText.slice(0, 200) },
      )
    }
    try {
      maskBytes = await createEditMask({ imageWidth: source.width, imageHeight: source.height, selection })
    } catch (error) {
      return maskFailure(error)
    }
  } else {
    const bytes = Buffer.from(await maskPart!.arrayBuffer())
    try {
      // Enforces the alpha channel, resizes to exactly the source image's own
      // dimensions, and caps at the vendor limit — so a brush mask drawn at display
      // scale still lines up pixel for pixel.
      maskBytes = await normalizeAlphaMask(bytes, source.width, source.height)
    } catch (error) {
      return maskFailure(error)
    }
  }

  const maskUploadId = randomUUID()
  const maskObjectKey = stagedObjectKey(actor.id, maskUploadId, 'image/png')
  try {
    await ports.putObjectBytes(maskObjectKey, maskBytes, 'image/png')
    await ports.runTransaction(async client => {
      await storeReadyInputImage(client, {
        uploadId: maskUploadId,
        actorId: actor.id,
        objectKey: maskObjectKey,
        mimeType: 'image/png',
        width: source.width,
        height: source.height,
        sizeBytes: maskBytes.length,
        checksum: createHash('sha256').update(maskBytes).digest('hex'),
        ttlSeconds: limits.uploadTtlSeconds,
      })
    })
  } catch {
    await ports.deleteObject(maskObjectKey).catch(() => { /* orphan accepted */ })
    return fail('GENERATION_CREATE_FAILED', '遮罩存储失败，请稍后重试', 503)
  }
  const maskInput: GenerationInputItem = { uploadId: maskUploadId, role: MASK_INPUT_ROLE, position: 1 }

  // --- the job --------------------------------------------------------------
  // Client-chosen parameters first, then the two this route owns: the output size
  // follows the source image's geometry and one edit returns one picture, so a
  // caller-supplied `size` or `count` is overridden rather than trusted.
  const parameters: Record<string, unknown> = { ...clientParameters, size }
  if (quality) parameters.quality = quality
  // One edit, one picture: `count > 1` would spend the same mask several times over,
  // which is not a choice this endpoint offers.
  parameters.count = 1

  return ports.createJob({
    actor,
    modelId,
    // The user's own words, wrapped by the shared standing instruction — the only
    // place that composition happens, so the wording cannot drift from the contract.
    prompt: buildInpaintPrompt(prompt),
    parameters,
    normalizedInputs: [sourceInput, maskInput],
    idempotencyKey: request.headers.get('idempotency-key')
      || (textOf(fields, 'idempotencyKey') || randomUUID()),
  })
}
