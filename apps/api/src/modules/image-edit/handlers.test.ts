import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ok } from '../../shared/http'
import { buildInpaintPrompt, MASK_INPUT_ROLE, MAX_MASK_BYTES, MIN_EDIT_SELECTION_PX } from '@musecanvas/contracts'
import { createEditMask } from '../../../../../packages/providers/src/index'
import { resolvePresetCapabilities } from '../../admin/model-presets'
import type { CreateGenerationJobCommand } from '../generations/create-job'
import type { Actor } from '../../auth/security'
import type { AuthedContext } from '../../router/types'
import { editImage, storeReadyInputImage, type ImageEditPorts, type SqlClient } from './handlers'

/**
 * `POST /api/images/edit`, against stubbed collaborators.
 *
 * No network, no Postgres, no S3: the route's interesting claims are all of the
 * form "this never touched storage" or "this row describes exactly those bytes",
 * and a recording `ImageEditPorts` is the only way to see them. The images
 * themselves are real — rasterised by the shipped `createEditMask` — because
 * dimension and checksum behaviour has to be measured on decodable PNG bytes
 * rather than asserted on a fixture that lies about its own size.
 */

const MODEL_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '22222222-2222-4222-8222-222222222222'
const ACTOR_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_USER = '44444444-4444-4444-8444-444444444444'
const ASSET_KEY = 'outputs/other-user/asset-1.png'
/** Non-square on purpose: the picked size has to follow the source's aspect ratio. */
const SOURCE_WIDTH = 1200
const SOURCE_HEIGHT = 800

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const sourcePng = await createEditMask({
  imageWidth: SOURCE_WIDTH,
  imageHeight: SOURCE_HEIGHT,
  selection: { x: 0, y: 0, width: MIN_EDIT_SELECTION_PX, height: MIN_EDIT_SELECTION_PX },
})

/** The capability snapshot a real enabled `openai-gpt-image-2` row carries. */
const maskContract = (await resolvePresetCapabilities('openai-image', '1.1.0', 'gpt-image-2')).capabilities
/** A real image model that declares no `mask` slot: the refusal must name that. */
const noMaskContract = (await resolvePresetCapabilities('openai-image', '1.1.0', 'gpt-image-1.5')).capabilities
/** A model pinned before any plugin authored its contract. */
const undeclaredContract = (await resolvePresetCapabilities('openai-image', '1.0.0', 'gpt-image-2')).capabilities

const modelRow = (capabilities: unknown, overrides: Record<string, unknown> = {}) => ({
  id: MODEL_ID,
  display_name: 'GPT Image 2',
  model_kind: 'image',
  enabled: true,
  deleted_at: null,
  capabilities,
  defaults: {},
  revision: 3,
  ...overrides,
})

const assetRow = (overrides: Record<string, unknown> = {}) => ({
  id: ASSET_ID,
  object_key: ASSET_KEY,
  media_kind: 'image',
  mime_type: 'image/png',
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
  created_by: ACTOR_ID,
  ...overrides,
})

type FileField = { bytes: Uint8Array; type?: string; name?: string }
type FormFields = Record<string, string | FileField>

const editForm = (fields: FormFields): FormData => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') form.append(key, value)
    else form.append(key, new Blob([new Uint8Array(value.bytes)], { type: value.type ?? 'image/png' }), value.name ?? `${key}.png`)
  }
  return form
}

/** The minimum the route needs from a `NextRequest`: the body and one header. */
const editContext = (form: FormData, headers: Record<string, string> = {}) => ({
  actor: { id: ACTOR_ID, role: 'user' } as Actor,
  request: {
    formData: async () => form,
    headers: new Headers(headers),
  },
}) as unknown as AuthedContext

interface HarnessOptions {
  model?: Record<string, unknown> | null
  asset?: Record<string, unknown> | null
  /** Object keys the bucket actually holds. Anything else throws like S3 would. */
  objects?: Record<string, Buffer>
  limited?: boolean
  putFails?: boolean
  transactionFails?: boolean
}

/**
 * A recording stand-in for the whole outside world. The `db` fake answers the two
 * reads this route issues *with their own predicates applied*, so "another user's
 * asset" is simulated by the ownership clause rather than by a hand-written empty.
 */
function harness(options: HarnessOptions = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const puts: Array<{ objectKey: string; bytes: Buffer; contentType: string }> = []
  const reads: string[] = []
  const deletes: string[] = []
  const commands: CreateGenerationJobCommand[] = []
  const asset = options.asset === undefined ? assetRow() : options.asset
  const objects = options.objects ?? { [ASSET_KEY]: sourcePng }

  const client: SqlClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params })
      if (options.transactionFails) throw new Error('DB_WRITE_FAILED')
      return { rows: [] }
    },
  }

  const ports: ImageEditPorts = {
    db: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params })
        if (sql.includes('FROM model_configs')) {
          const row = options.model === undefined ? modelRow(maskContract) : options.model
          return { rows: row && String(row.id) === String(params[0]) ? [row] : [] }
        }
        if (sql.includes('FROM assets')) {
          // `WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL`, honoured.
          if (!asset) return { rows: [] }
          const owned = String(asset.id) === String(params[0]) && String(asset.created_by) === String(params[1])
          return { rows: owned ? [asset] : [] }
        }
        return { rows: [] }
      },
    }),
    runTransaction: async fn => { await fn(client) },
    limited: async () => options.limited ?? false,
    readObjectBytes: async objectKey => {
      reads.push(objectKey)
      const bytes = objects[objectKey]
      if (!bytes) throw new Error('S3_NOT_FOUND')
      return bytes
    },
    putObjectBytes: async (objectKey, bytes, contentType) => {
      if (options.putFails) throw new Error('S3_PUT_FAILED')
      puts.push({ objectKey, bytes, contentType })
    },
    deleteObject: async objectKey => { deletes.push(objectKey) },
    uploadLimits: async () => ({ maxImageBytes: 10_000_000, uploadTtlSeconds: 86400 }),
    createJob: async command => {
      commands.push(command)
      return ok({ id: 'job-1', marker: 'from-create-generation-job' }, { status: 202 })
    },
  }

  const insertsFor = (table: string) => queries.filter(entry => entry.sql.includes(`INSERT INTO ${table}`))
  const sqlFor = (table: string) => queries.filter(entry => entry.sql.includes(table)).map(entry => entry.sql).join('\n')
  return { ports, queries, puts, reads, deletes, commands, insertsFor, sqlFor }
}

const errorOf = async (response: Response): Promise<{ status: number; code: string; message: string }> => {
  const payload = await response.json() as { success: boolean; error?: { code?: string; message?: string } }
  assert.equal(payload.success, false, 'a refused edit must keep the {success:false,error} envelope')
  const error = payload.error
  assert.ok(error && typeof error.code === 'string' && typeof error.message === 'string', 'a refusal must carry a code and a readable message')
  return { status: response.status, code: error.code, message: error.message }
}

/** `parameters` is the optional half of the command; every assertion here wants an object. */
const parametersOf = (command: CreateGenerationJobCommand): Record<string, unknown> => command.parameters ?? {}

/** Text fields only, with the source image already resolved from the gallery. */
const assetFields = (extra: Record<string, string> = {}): FormFields => ({
  modelId: MODEL_ID,
  prompt: '把选区里的猫换成一只柴犬',
  assetId: ASSET_ID,
  region: JSON.stringify({ x: 100, y: 100, width: 400, height: 300 }),
  ...extra,
})

test('a request over the generation budget is refused before the body is read', async () => {
  const h = harness({ limited: true })
  const response = await editImage(editContext(editForm(assetFields())), h.ports)
  const error = await errorOf(response)
  assert.equal(error.status, 429)
  assert.equal(error.code, 'RATE_LIMITED')
  // The bucket is the generation bucket: an edit is a generation, and a second
  // budget on this path would be a second allowance.
  const keys: string[] = []
  const ports = { ...h.ports, limited: async (key: string) => { keys.push(key); return false } }
  await editImage(editContext(editForm(assetFields())), ports as ImageEditPorts)
  assert.deepEqual(keys, [`gen:create:${ACTOR_ID}`])
  assert.equal(h.commands.length, 1)
})

test('an unexpected form key is refused without touching the database or the bucket', async () => {
  const form = editForm(assetFields())
  form.append('count', '4')
  const h = harness()
  const error = await errorOf(await editImage(editContext(form), h.ports))
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /count/)
  assert.deepEqual(h.queries, [])
  assert.deepEqual(h.puts, [])
})

test('a duplicated image or mask part is refused', async () => {
  for (const field of ['image', 'mask']) {
    const form = new FormData()
    form.append('modelId', MODEL_ID)
    form.append('prompt', '换掉选区里的内容')
    form.append('region', JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }))
    form.append('assetId', ASSET_ID)
    form.append(field, new Blob([new Uint8Array(sourcePng)], { type: 'image/png' }), `${field}-a.png`)
    form.append(field, new Blob([new Uint8Array(sourcePng)], { type: 'image/png' }), `${field}-b.png`)
    const h = harness()
    const error = await errorOf(await editImage(editContext(form), h.ports))
    assert.equal(error.code, 'INVALID_INPUT', field)
    assert.match(error.message, new RegExp(field), field)
    assert.deepEqual(h.queries, [], `a ${field} duplicate must be refused before any query`)
  }
})

test('exactly one source is required: assetId and image together, or neither, both fail', async () => {
  const both = editForm({
    modelId: MODEL_ID,
    prompt: '换掉选区里的内容',
    assetId: ASSET_ID,
    image: { bytes: new Uint8Array(sourcePng) },
    region: JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }),
  })
  const bothError = await errorOf(await editImage(editContext(both), harness().ports))
  assert.equal(bothError.code, 'INVALID_INPUT')
  assert.match(bothError.message, /源图/)

  const neither = editForm({
    modelId: MODEL_ID,
    prompt: '换掉选区里的内容',
    region: JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }),
  })
  const neitherError = await errorOf(await editImage(editContext(neither), harness().ports))
  assert.equal(neitherError.code, 'INVALID_INPUT')
  assert.match(neitherError.message, /缺少源图/)
})

test('exactly one region kind is required: region and mask together, or neither, both fail', async () => {
  const both = editForm({
    modelId: MODEL_ID,
    prompt: '换掉选区里的内容',
    assetId: ASSET_ID,
    region: JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }),
    mask: { bytes: new Uint8Array(sourcePng) },
  })
  const bothError = await errorOf(await editImage(editContext(both), harness().ports))
  assert.equal(bothError.code, 'INVALID_INPUT')
  assert.match(bothError.message, /选区/)

  const neither = editForm({ modelId: MODEL_ID, prompt: '换掉选区里的内容', assetId: ASSET_ID })
  const neitherError = await errorOf(await editImage(editContext(neither), harness().ports))
  assert.equal(neitherError.code, 'INVALID_INPUT')
  assert.match(neitherError.message, /缺少选区/)
})

test('a region outside the image or below the minimum is refused with a readable message', async () => {
  const cases: Array<[string, { x: number; y: number; width: number; height: number }]> = [
    ['off the right edge', { x: SOURCE_WIDTH - 4, y: 10, width: 200, height: 200 }],
    ['below the minimum', { x: 10, y: 10, width: MIN_EDIT_SELECTION_PX - 1, height: 400 }],
    ['entirely outside', { x: 5000, y: 5000, width: 100, height: 100 }],
    ['not a rectangle', { x: 10, y: 10, width: 0, height: 100 }],
  ]
  for (const [label, region] of cases) {
    const h = harness()
    const error = await errorOf(await editImage(
      editContext(editForm(assetFields({ region: JSON.stringify(region) }))),
      h.ports,
    ))
    assert.equal(error.code, 'INVALID_INPUT', label)
    assert.match(error.message, /框选区域无效/, label)
    // The message has to be actionable on its own: what the user drew, in whose units.
    assert.ok(error.message.includes(`${SOURCE_WIDTH}×${SOURCE_HEIGHT}`), `${label}: ${error.message}`)
    assert.ok(error.message.includes(String(MIN_EDIT_SELECTION_PX)), `${label}: ${error.message}`)
    assert.deepEqual(h.puts, [], `${label}: a rejected region must not reach object storage`)
    assert.equal(h.commands.length, 0, label)
  }
  for (const region of ['not json', '{"x":1,"y":1,"width":100,"height":100', '{"type":"mask","x":1,"y":1}']) {
    const error = await errorOf(await editImage(
      editContext(editForm(assetFields({ region }))),
      harness().ports,
    ))
    assert.equal(error.code, 'INVALID_INPUT', region)
    assert.match(error.message, /region 必须是/, region)
  }
})

test('a model without a mask slot is refused before any storage call', async () => {
  for (const [label, capabilities] of [
    ['no mask slot', noMaskContract],
    ['undeclared contract', undeclaredContract],
  ] as const) {
    const h = harness({ model: modelRow(capabilities) })
    const error = await errorOf(await editImage(editContext(editForm(assetFields())), h.ports))
    assert.equal(error.code, 'MODEL_MASK_NOT_SUPPORTED', label)
    assert.match(error.message, /局部修改/, label)
    assert.deepEqual(h.puts, [], `${label}: nothing may be written first`)
    assert.deepEqual(h.reads, [], `${label}: not even the gallery source may be fetched`)
    assert.equal(h.sqlFor('generation_input_images'), '', `${label}: no input row may exist`)
    assert.equal(h.commands.length, 0, label)
  }
})

test('a non-image or missing model is refused, and the asset is never fetched for it', async () => {
  const missing = harness({ model: null })
  const missingError = await errorOf(await editImage(editContext(editForm(assetFields())), missing.ports))
  assert.equal(missingError.code, 'MODEL_NOT_AVAILABLE')
  assert.equal(missingError.status, 404)
  assert.deepEqual(missing.reads, [])

  const video = harness({ model: modelRow(maskContract, { model_kind: 'video' }) })
  const videoError = await errorOf(await editImage(editContext(editForm(assetFields())), video.ports))
  assert.equal(videoError.code, 'MODEL_NOT_AVAILABLE')
  assert.match(videoError.message, /图片生成模型/)
  assert.deepEqual(video.reads, [])
})

test('an asset owned by someone else is refused through the ownership predicate', async () => {
  const h = harness({ asset: assetRow({ created_by: OTHER_USER }) })
  const error = await errorOf(await editImage(editContext(editForm(assetFields())), h.ports))
  assert.equal(error.code, 'NOT_FOUND')
  assert.equal(error.status, 404)
  const select = h.queries.find(entry => entry.sql.includes('FROM assets'))
  assert.ok(select, 'the asset read must happen at all')
  assert.match(select.sql, /created_by\s*=\s*\$2/)
  assert.match(select.sql, /deleted_at IS NULL/)
  assert.deepEqual(select.params, [ASSET_ID, ACTOR_ID])
  assert.deepEqual(h.reads, [], 'a foreign asset must not even be fetched from the bucket')
  assert.equal(h.commands.length, 0)
})

test('a soft-deleted or non-PNG/JPEG asset is refused', async () => {
  const deleted = harness({ asset: null })
  assert.equal((await errorOf(await editImage(editContext(editForm(assetFields())), deleted.ports))).code, 'NOT_FOUND')
  for (const overrides of [{ mime_type: 'image/webp' }, { media_kind: 'video' }]) {
    const h = harness({ asset: assetRow(overrides) })
    const error = await errorOf(await editImage(editContext(editForm(assetFields())), h.ports))
    assert.equal(error.code, 'INVALID_INPUT_IMAGE')
    assert.deepEqual(h.puts, [], JSON.stringify(overrides))
  }
})

test('a gallery source is referenced by assetId and never mirrored into an upload row', async () => {
  const h = harness()
  const response = await editImage(editContext(editForm(assetFields())), h.ports)
  assert.equal(response.status, 202)
  assert.deepEqual(h.reads, [ASSET_KEY])
  // The failure this prevents: an upload row carrying the asset's own key would be
  // deleted by the input TTL sweep, taking the user's original artwork with it.
  const rows = [...h.insertsFor('generation_input_images'), ...h.insertsFor('media_uploads')]
  assert.equal(rows.length, 2, 'exactly one input pair: the mask')
  for (const row of rows) {
    assert.equal(row.params.includes(ASSET_KEY), false, 'the asset object key must never enter an upload row')
    assert.equal(row.params.includes(ASSET_ID), false, 'the asset id must never enter an upload row')
  }
  const [source, mask] = h.commands[0].normalizedInputs
  assert.deepEqual(source, { assetId: ASSET_ID, role: 'reference_image', position: 0 })
  assert.equal(mask.role, MASK_INPUT_ROLE)
  assert.equal(mask.position, 1)
  assert.ok(mask.uploadId)
})

test('the mask row is ready, and its checksum, size and mime describe exactly the stored bytes', async () => {
  const h = harness()
  await editImage(editContext(editForm(assetFields())), h.ports)
  assert.equal(h.puts.length, 1, 'a gallery source adds no object of its own')
  const stored = h.puts[0]
  assert.match(stored.objectKey, new RegExp(`^inputs/${ACTOR_ID}/[0-9a-f-]+\\.png$`))
  assert.equal(stored.contentType, 'image/png')

  for (const [table, inserts] of [
    ['generation_input_images', h.insertsFor('generation_input_images')],
    ['media_uploads', h.insertsFor('media_uploads')],
  ] as const) {
    assert.equal(inserts.length, 1, table)
    const [row] = inserts
    assert.match(row.sql, /'ready'/, `${table}: the worker requires a ready row`)
    assert.equal(row.params[0], stored.objectKey.match(/[0-9a-f-]+(?=\.png$)/)?.[0], `${table}: upload id`)
    assert.equal(row.params[1], ACTOR_ID, table)
    assert.equal(row.params[2], stored.objectKey, table)
    assert.equal(row.params[3], 'image/png', table)
    assert.deepEqual(row.params.slice(4, 6), [SOURCE_WIDTH, SOURCE_HEIGHT], `${table}: mask size is the image size`)
    assert.equal(row.params[6], stored.bytes.length, `${table}: size_bytes is the stored length`)
    assert.equal(row.params[7], sha256(stored.bytes), `${table}: checksum is the stored bytes`)
    assert.match(row.sql, /interval '1 second'/, `${table}: the row carries a TTL`)
  }
  // The vendor rule the whole route exists to satisfy.
  assert.ok(stored.bytes.length <= MAX_MASK_BYTES)
})

test('a browser-posted source image is staged as a ready upload row and passed by uploadId', async () => {
  const h = harness({ asset: null })
  const response = await editImage(editContext(editForm({
    modelId: MODEL_ID,
    prompt: '把选区里的猫换成一只柴犬',
    image: { bytes: new Uint8Array(sourcePng), name: 'photo.png' },
    region: JSON.stringify({ x: 50, y: 50, width: 300, height: 200 }),
  })), h.ports)
  assert.equal(response.status, 202)
  assert.deepEqual(h.reads, [], 'an uploaded source is stored, not fetched back')
  assert.equal(h.puts.length, 2)
  const [sourcePut, maskPut] = h.puts
  assert.match(sourcePut.objectKey, new RegExp(`^inputs/${ACTOR_ID}/[0-9a-f-]+\\.png$`))
  assert.equal(sourcePut.bytes.length, sourcePng.length)
  assert.notEqual(sourcePut.objectKey, maskPut.objectKey, 'the source and the mask are distinct objects')

  const [sourceRow, maskRow] = h.insertsFor('generation_input_images')
  assert.equal(sourceRow.params[2], sourcePut.objectKey)
  assert.equal(sourceRow.params[6], sourcePng.length)
  assert.equal(sourceRow.params[7], sha256(sourcePng))
  assert.equal(maskRow.params[2], maskPut.objectKey)
  assert.equal(maskRow.params[7], sha256(Buffer.from(maskPut.bytes)))

  const [source, mask] = h.commands[0].normalizedInputs
  assert.equal(source.role, 'reference_image')
  assert.equal(source.position, 0)
  assert.equal(source.uploadId, sourceRow.params[0])
  assert.equal(mask.role, MASK_INPUT_ROLE)
  assert.equal(mask.position, 1)
  assert.equal(mask.uploadId, maskRow.params[0])
})

test('an uploaded source that is not a decodable image is refused before anything is stored', async () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array(Buffer.from('not an image at all'))]) {
    const h = harness({ asset: null })
    const error = await errorOf(await editImage(editContext(editForm({
      modelId: MODEL_ID,
      prompt: '换掉选区里的内容',
      image: { bytes, name: 'broken.png' },
      region: JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }),
    })), h.ports))
    assert.equal(error.code, 'INVALID_INPUT_IMAGE')
    assert.match(error.message, /源图/)
    assert.deepEqual(h.puts, [])
  }
})

test('a mask without an alpha channel is refused, and a correct one is resized to the image', async () => {
  // A genuinely decodable 64x64 PNG whose IHDR colour type is 2 (truecolour, no
  // alpha band). `normalizeAlphaMask` rejects it rather than converting it into a
  // mask that would silently mean "edit nothing".
  const opaquePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAoUlEQVR4nO2SQQkAQRDDqqRKTkn8C1kR9wgDhQpIQtOP04tO0AmgV+wuxN1FJ+gE0Ct2F+LuohN0AugVuwtxd9EJOgH0it2FuLvoBJ0AesXuQtxddIJOAL1idyHuLjpBJ4BesbsQdxedoBNAr9hdiLuLTtAJoFfsLsTdRSfoBNArdhfi7qITdALoFbsLcXfRCToB9Irdhbi76ASdAHrFPxd6WAxApm1NYrAAAAAASUVORK5CYII=',
    'base64',
  )
  assert.equal(opaquePng.readUInt8(25), 2, 'the fixture must stay an alpha-less PNG')
  const h = harness()
  const error = await errorOf(await editImage(editContext(editForm({
    modelId: MODEL_ID,
    prompt: '换掉选区里的内容',
    assetId: ASSET_ID,
    mask: { bytes: new Uint8Array(opaquePng), name: 'mask.png' },
  })), h.ports))
  assert.equal(error.code, 'INVALID_INPUT_IMAGE')
  assert.match(error.message, /alpha/)
  assert.deepEqual(h.puts, [])

  // A mask drawn at display scale still lands on the right pixels: it is resized to
  // exactly the source dimensions, and that is what the row records.
  const smallMask = await createEditMask({
    imageWidth: 120,
    imageHeight: 80,
    selection: { x: 10, y: 10, width: 60, height: 40 },
  })
  const okHarness = harness()
  const response = await editImage(editContext(editForm({
    modelId: MODEL_ID,
    prompt: '换掉选区里的内容',
    assetId: ASSET_ID,
    mask: { bytes: new Uint8Array(smallMask), name: 'mask.png' },
  })), okHarness.ports)
  assert.equal(response.status, 202)
  const [row] = okHarness.insertsFor('generation_input_images')
  assert.deepEqual(row.params.slice(4, 6), [SOURCE_WIDTH, SOURCE_HEIGHT], 'the stored mask matches the image exactly')
})

test('the job is created through the shared contract with a wrapped prompt, one picture and a legal size', async () => {
  const h = harness()
  const response = await editImage(editContext(editForm(assetFields({ quality: 'high' }))), h.ports)
  // The creation contract's own response, untouched: 202 plus the job DTO.
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { success: true, data: { id: 'job-1', marker: 'from-create-generation-job' } })

  assert.equal(h.commands.length, 1)
  const command = h.commands[0]
  assert.equal(command.modelId, MODEL_ID)
  assert.equal(command.actor.id, ACTOR_ID)
  // The user's words survive verbatim at the end of the standing instruction, and
  // this route is the only place that composition happens.
  assert.equal(command.prompt, buildInpaintPrompt('把选区里的猫换成一只柴犬'))
  assert.match(command.prompt, /User request:\n把选区里的猫换成一只柴犬$/)
  assert.ok(command.prompt.length > '把选区里的猫换成一只柴犬'.length)
  // 1200x800 is 3:2 — the model's own nearest legal size, not its `auto` default.
  assert.equal(parametersOf(command).size, '1536x1024')
  assert.equal(parametersOf(command).quality, 'high')
  assert.equal(parametersOf(command).count, 1)
  assert.equal(typeof command.idempotencyKey, 'string')
  assert.match(command.idempotencyKey, /^[0-9a-f-]{36}$/)
})

test('the output size follows the source image, not the model default', async () => {
  // Portrait: the same picker on the same model answers a different literal, and
  // 1000x1500 has exactly one legal match — so this can only pass if the source's
  // own aspect ratio drove the choice rather than the model's `auto` default.
  const tall = await createEditMask({
    imageWidth: 1000,
    imageHeight: 1500,
    selection: { x: 0, y: 0, width: MIN_EDIT_SELECTION_PX, height: MIN_EDIT_SELECTION_PX },
  })
  const h = harness({ asset: assetRow({ width: 1000, height: 1500 }), objects: { [ASSET_KEY]: tall } })
  await editImage(editContext(editForm(assetFields())), h.ports)
  assert.equal(parametersOf(h.commands[0]).size, '1024x1536')
})

test('a model that declares no usable size options fails instead of guessing', async () => {
  // Structurally a valid contract — an enumerated `size` offering only `auto`, as a
  // host-synthesized legacy revision might — with no `WIDTHxHEIGHT` to pick.
  // The GPT Image cross-field rule is dropped with the parameters it references.
  const noSizes = {
    ...maskContract,
    parameters: [{ type: 'enum', name: 'size', label: '尺寸', options: ['auto'] }],
    crossFieldConstraints: [],
  }
  const h = harness({ model: modelRow(noSizes) })
  const error = await errorOf(await editImage(editContext(editForm(assetFields())), h.ports))
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /输出尺寸/)
  // The refusal lands before the mask is rasterised and stored, so an unanswerable
  // model leaves nothing behind in the bucket.
  assert.equal(h.commands.length, 0)
  assert.deepEqual(h.puts, [])
  assert.equal(h.sqlFor('generation_input_images'), '')
})

test('the idempotency key comes from the header, then the form field, then a fresh uuid', async () => {
  const header = harness()
  await editImage(editContext(editForm(assetFields()), { 'idempotency-key': 'shared-key-1' }), header.ports)
  assert.equal(header.commands[0].idempotencyKey, 'shared-key-1')

  const field = harness()
  await editImage(
    editContext(editForm(assetFields({ idempotencyKey: ' shared-key-2 ' }))),
    field.ports,
  )
  assert.equal(field.commands[0].idempotencyKey, 'shared-key-2')

  const generated = harness()
  await editImage(editContext(editForm(assetFields())), generated.ports)
  await editImage(editContext(editForm(assetFields())), generated.ports)
  assert.match(generated.commands[0].idempotencyKey, /^[0-9a-f-]{36}$/)
  assert.notEqual(generated.commands[0].idempotencyKey, generated.commands[1].idempotencyKey)
})

test('a body that is not multipart is refused with a readable message', async () => {
  const context = {
    actor: { id: ACTOR_ID, role: 'user' } as Actor,
    request: {
      formData: async () => { throw new TypeError('no multipart boundary') },
      headers: new Headers(),
    },
  } as unknown as AuthedContext
  const error = await errorOf(await editImage(context, harness().ports))
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /multipart\/form-data/)
})

test('an invalid model id or prompt is refused on the same rules the generation route uses', async () => {
  const cases: Array<[string, FormFields]> = [
    ['not a uuid', assetFields({ modelId: 'gpt-image-2' })],
    ['empty prompt', assetFields({ prompt: '   ' })],
    ['over-long prompt', assetFields({ prompt: 'x'.repeat(4001) })],
    ['prompt with control chars', assetFields({ prompt: '换掉\u0007它' })],
    ['a file where prompt belongs', { ...assetFields(), prompt: { bytes: new Uint8Array(sourcePng) } }],
  ]
  for (const [label, fields] of cases) {
    const h = harness()
    const error = await errorOf(await editImage(editContext(editForm(fields)), h.ports))
    assert.equal(error.code, 'INVALID_INPUT', label)
    assert.deepEqual(h.queries, [], `${label}: refused before the model lookup`)
  }
})

test('a storage failure on the mask leaves a compensating delete and no job', async () => {
  const h = harness({ putFails: true })
  const error = await errorOf(await editImage(editContext(editForm(assetFields())), h.ports))
  assert.equal(error.code, 'GENERATION_CREATE_FAILED')
  assert.equal(error.status, 503)
  assert.equal(h.commands.length, 0)

  const lostWrite = harness()
  // Object stored, row never written: the object is the orphan, not the row.
  const ports: ImageEditPorts = {
    ...lostWrite.ports,
    putObjectBytes: async () => undefined,
    runTransaction: async () => { throw new Error('DB_UNREACHABLE') },
  }
  const second = await editImage(editContext(editForm(assetFields())), ports)
  assert.equal(second.status, 503)
  assert.equal(lostWrite.deletes.length, 1)
  assert.match(lostWrite.deletes[0], /^inputs\/33333333/)
})

test('storeReadyInputImage writes both rows in one shape and survives a missing mirror table', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  let mirrorThrows = false
  const client: SqlClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params })
      if (sql.includes('INSERT INTO media_uploads') && mirrorThrows) throw new Error('42P01 no relation media_uploads')
      return { rows: [] }
    },
  }
  const bytes = Buffer.from(sourcePng)
  const row = {
    uploadId: '55555555-5555-4555-8555-555555555555',
    actorId: ACTOR_ID,
    objectKey: `inputs/${ACTOR_ID}/55555555-5555-4555-8555-555555555555.png`,
    mimeType: 'image/png',
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
    sizeBytes: bytes.length,
    checksum: sha256(bytes),
    ttlSeconds: 86400,
  }
  await storeReadyInputImage(client, row)
  assert.deepEqual(queries.map(entry => entry.sql.match(/INSERT INTO (\w+)/)?.[1]), ['generation_input_images', 'media_uploads'])
  assert.equal(queries[0].params[3], 'image/png')
  // Both rows carry the same nine values in the same order: id, owner, key, mime,
  // geometry, byte count, digest, TTL.
  assert.deepEqual(queries[0].params, queries[1].params)
  assert.equal(queries[1].params[6], bytes.length)
  assert.equal(queries[1].params[8], 86400)
  // An older database without the generic table keeps working on the legacy row.
  queries.length = 0
  mirrorThrows = true
  await storeReadyInputImage(client, row)
  assert.equal(queries.length, 2)
})

test('every declared control rides in `parameters` and reaches the job', async () => {
  const h = harness()
  await editImage(editContext(editForm(assetFields({
    parameters: JSON.stringify({ background: 'transparent', output_format: 'png', input_fidelity: 'high' }),
  }))), h.ports)
  const parameters = parametersOf(h.commands[0])
  // A control the console still shows must never be silently dropped on this path.
  assert.equal(parameters.background, 'transparent')
  assert.equal(parameters.output_format, 'png')
  assert.equal(parameters.input_fidelity, 'high')
  // The two the route owns stay its own.
  assert.equal(parameters.size, '1536x1024')
  assert.equal(parameters.count, 1)
})

test('`parameters` can never override the size or count this route derives', async () => {
  const h = harness()
  await editImage(editContext(editForm(assetFields({
    parameters: JSON.stringify({ size: '1024x1024', count: 4 }),
    quality: 'low',
  }))), h.ports)
  const parameters = parametersOf(h.commands[0])
  assert.equal(parameters.size, '1536x1024', 'the output size follows the source geometry')
  assert.equal(parameters.count, 1, 'one edit returns one picture')
  assert.equal(parameters.quality, 'low', 'the scalar field wins over a packed object')
})

test('a malformed `parameters` body is refused before anything is stored', async () => {
  for (const value of ['{', '[]', '"transparent"', 'null']) {
    const h = harness()
    const error = await errorOf(await editImage(editContext(editForm(assetFields({ parameters: value }))), h.ports))
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, /parameters/)
    assert.equal(h.puts.length, 0, `${value} must not reach the bucket`)
    assert.equal(h.commands.length, 0, `${value} must not create a job`)
  }
})
