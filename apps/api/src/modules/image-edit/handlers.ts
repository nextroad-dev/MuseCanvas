import { randomUUID } from 'node:crypto'
import type { NextResponse } from 'next/server'
import {
  MASK_INPUT_ROLE,
  RUNTIME_SETTINGS_DEFAULTS,
} from '@musecanvas/contracts'
import { db, transaction } from '../../../../../packages/database/src/index'
import type { AuthedContext } from '../../router/types'
import { fail } from '../../shared/http'
import { limited } from '../../shared/redis'
import {
  deleteS3Object,
  getPrivateS3ObjectBytes,
  putPrivateS3ObjectBytes,
  putReservedImageMask,
} from '../../shared/services'
import { GENERATION_UPLOAD_TTL_SECONDS } from '../generation-uploads'
import { resolveRuntimeSettings } from '../settings/runtime'
import { createGenerationJob, type CreateGenerationJobCommand } from '../generations/create-job'
import { createStableUploadIds, prepareImageEdit, type PreparedImageEdit } from './prepare'

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
  putReservedMask?: (objectKey: string, bytes: Buffer) => Promise<void>
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
  putReservedMask: putReservedImageMask,
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
  expiresAt?: string
}

/**
 * Write the dual inspected input row. The manual path defaults to `ready` after
 * PUT. Reserved Agent masks use `pending` BEFORE immutable PUT so existing TTL
 * cleanup can reclaim an orphan object; the preparation lease later fences both
 * rows' pending→ready transition. Geometry/checksum describe the exact bytes.
 * The legacy mirror fallback is retained for the unchanged manual path.
 */
export async function storeReadyInputImage(client: SqlClient, row: ReadyInputWrite, status: 'ready' | 'pending' = 'ready'): Promise<void> {
  const statusSql = status === 'pending' ? "'pending'" : "'ready'"
  // Keyed edits derive the same upload id for the same artifact, so a retried
  // request must not fail on the row it already wrote — and must not overwrite
  // it with different bytes either. The follow-up read is the arbiter.
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  )
  try {
    await client.query(
      `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
       VALUES($1, $2, 'image', ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
      [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
    )
  } catch {
    // media_uploads table may not exist on older databases; the legacy row stays source of truth.
  }
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum FROM generation_input_images WHERE id=$1',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (existing && !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
}

/** The stored row describes exactly the artifact this caller staged. */
const rowIdentityMatches = (existing: Record<string, unknown>, row: ReadyInputWrite): boolean =>
  String(existing.created_by) === row.actorId
  && String(existing.object_key) === row.objectKey
  && String(existing.mime_type) === row.mimeType
  && Number(existing.width) === row.width
  && Number(existing.height) === row.height
  && Number(existing.size_bytes) === row.sizeBytes
  && String(existing.checksum) === row.checksum

/**
 * Row-first claim for a key-scoped idempotent edit.
 *
 * The row exists before any object is written, so a failed attempt leaves a
 * TTL-reclaimable pending row instead of a shared object that a concurrent
 * loser could delete, or an object no row can ever reclaim. Rows whose object
 * was already reclaimed, or whose unattached lifetime already expired, are
 * refused rather than rebuilt underneath the tombstone: the caller must start a
 * new request (a new idempotency key) instead.
 */
/** A row the TTL sweep already reclaimed: it must not be rebuilt underneath. */
const rowTombstoned = (row: Record<string, unknown>): boolean =>
  String(row.status) === 'deleted' || Boolean(row.object_deleted_at)

/**
 * Lock the media mirror before the legacy row: the shared attach path takes
 * `media_uploads` first, then `generation_input_images`, and inverting that
 * order deadlocks the two against each other. An absent mirror table (older
 * databases) is skipped rather than failing the write.
 */
/** Only a genuinely missing mirror table is tolerated; any other error must fail loudly. */
export function mirrorTableMissing(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === '42P01') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('42P01') || message.includes('relation "media_uploads" does not exist')
}

async function lockMediaRowForUpdate(client: SqlClient, uploadId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const locked = await client.query(
      'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at, expires_at FROM media_uploads WHERE id=$1 FOR UPDATE',
      [uploadId]
    )
    return locked.rows[0]
  } catch (error) {
    if (!mirrorTableMissing(error)) throw error
    return undefined
  }
}

export async function claimKeyedInputRow(client: SqlClient, row: ReadyInputWrite): Promise<void> {
  const params = [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  try {
    await client.query(
      `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
       VALUES($1, $2, 'image', 'pending', $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
      params
    )
  } catch (error) {
    // media_uploads may not exist on older databases; the legacy row stays source of truth.
    if (!mirrorTableMissing(error)) throw error
  }
  const mirror = await lockMediaRowForUpdate(client, row.uploadId)
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, 'pending', $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    params
  )
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at, expires_at FROM generation_input_images WHERE id=$1 FOR UPDATE',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (!existing || !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (mirror && !rowIdentityMatches(mirror, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (rowTombstoned(existing) || (mirror && rowTombstoned(mirror))) throw new Error('INPUT_ROW_RECLAIMED')
  if (Number(new Date(existing.expires_at as string | number | Date)) <= Date.now()) throw new Error('INPUT_ROW_RECLAIMED')
  if (mirror && Number(new Date(mirror.expires_at as string | number | Date)) <= Date.now()) throw new Error('INPUT_ROW_RECLAIMED')
  try {
    await client.query(
      "UPDATE media_uploads SET expires_at = COALESCE($2::timestamptz, now() + ($3 * interval '1 second')), updated_at=now() WHERE id=$1 AND status IN ('pending','ready')",
      [row.uploadId, row.expiresAt ?? null, row.ttlSeconds]
    )
  } catch (error) {
    // Missing generic table on older databases is tolerated consistently.
    if (!mirrorTableMissing(error)) throw error
  }
  await client.query(
    "UPDATE generation_input_images SET expires_at = COALESCE($2::timestamptz, now() + ($3 * interval '1 second')), updated_at=now() WHERE id=$1 AND status IN ('pending','ready')",
    [row.uploadId, row.expiresAt ?? null, row.ttlSeconds]
  )
}

/**
 * Promote a claimed keyed row after its object write. A concurrent request may
 * already have promoted (or attached) it; only `pending` is advanced, and a
 * reclaimed row fails closed.
 */
export async function promoteKeyedInputRow(client: SqlClient, row: ReadyInputWrite): Promise<void> {
  const mirror = await lockMediaRowForUpdate(client, row.uploadId)
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at FROM generation_input_images WHERE id=$1 FOR UPDATE',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (!existing || !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (mirror && !rowIdentityMatches(mirror, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (rowTombstoned(existing) || (mirror && rowTombstoned(mirror))) throw new Error('INPUT_ROW_RECLAIMED')
  try {
    await client.query("UPDATE media_uploads SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  } catch (error) {
    // Missing generic table on older databases is tolerated consistently.
    if (!mirrorTableMissing(error)) throw error
  }
  if (String(existing.status) === 'pending') {
    await client.query("UPDATE generation_input_images SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  }
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
