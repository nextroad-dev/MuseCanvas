import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MIN_EDIT_SELECTION_PX } from '@musecanvas/contracts'
import { createEditMask } from '@musecanvas/providers'
import { resolvePresetCapabilities } from '../../admin/model-presets'
import type { Actor } from '../../auth/security'
import type { AuthedContext } from '../../router/types'
import { prepareAgentImageEdit, storeReadyInputImage, type ImageEditPorts, type SqlClient } from './handlers'

/**
 * `POST /api/images/edit/preparations`, against stubbed collaborators.
 *
 * The direct `POST /api/generations` and `POST /api/images/edit` entry points no
 * longer exist: media generation is an Agent capability only. What remains here
 * is the staging route that feeds an accepted Agent turn — it stages a source and
 * a mask, writes one provenance identity and never creates a job.
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
/** Non-square on purpose: the mask has to follow the source's aspect ratio. */
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
  /** Simulates a stored job for the request's explicit idempotency key. */
  existingJob?: Record<string, unknown> | null
  /** Upload rows answered to the artifact-identity reads done for an existing job. */
  uploadRows?: Record<string, Record<string, unknown>>
  /** Pre-seeded `generation_input_images` rows, keyed by upload id. */
  stagedRows?: Record<string, Record<string, unknown>>
  /** Whether migration 0045's provenance table exists in this database. */
  schemaPresent?: boolean
  ownerActive?: boolean
  preparationScope?: { sessionId: string; ownerId: string; turnId: string; activeTurnId: string; status?: string; archived?: boolean; cancelled?: boolean; deadlineLive?: boolean }
}

/**
 * A recording stand-in for the whole outside world. The `db` fake answers the
 * reads this route issues *with their own predicates applied*, so "another
 * user's asset" is simulated by the ownership clause rather than by a
 * hand-written empty.
 */
function harness(options: HarnessOptions = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const puts: Array<{ objectKey: string; bytes: Buffer; contentType: string }> = []
  const reads: string[] = []
  const deletes: string[] = []
  const asset = options.asset === undefined ? assetRow() : options.asset
  const objects = options.objects ?? { [ASSET_KEY]: sourcePng }

  // A small row store so the keyed claim/promote SQL is exercised for real: the
  // inserted row answers the follow-up SELECT, and the promote UPDATE flips it.
  const rowsById = new Map<string, Record<string, unknown>>(Object.entries(options.stagedRows ?? {}))
  // 0045 provenance stand-in: the INSERT records the identity, the re-read replays it.
  let preparation: Record<string, unknown> | null = null
  const client: SqlClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params })
      if (options.transactionFails) throw new Error('DB_WRITE_FAILED')
      if (sql.startsWith('SELECT id FROM users')) return { rows: options.ownerActive === false ? [] : [{ id: ACTOR_ID }] }
      if (sql.includes('INSERT INTO agent_media_mask_preparations')) {
        preparation ??= {
          owner_id: String(params[1]),
          source_checksum: String(params[2]),
          mask_checksum: String(params[3]),
          width: Number(params[4]),
          height: Number(params[5]),
          preparation_version: 1,
          preparation_live: true,
        }
        return { rows: [] }
      }
      if (sql.includes('FROM agent_media_mask_preparations')) {
        return { rows: preparation ? [preparation] : [] }
      }
      if (sql.includes('FROM media_uploads') && sql.includes("status='ready'")) {
        // The ready-mask re-read before the identity insert: it only has to exist.
        return { rows: [{ id: String(params[0]) }] }
      }
      if (sql.includes('INSERT INTO generation_input_images')) {
        const id = String(params[0])
        if (!rowsById.has(id)) {
          rowsById.set(id, {
            created_by: String(params[1]),
            object_key: String(params[2]),
            mime_type: String(params[3]),
            width: Number(params[4]),
            height: Number(params[5]),
            size_bytes: Number(params[6]),
            checksum: String(params[7]),
            status: sql.includes("'pending'") ? 'pending' : 'ready',
            object_deleted_at: null,
            expires_at: new Date(Date.now() + Number(params[8]) * 1000).toISOString(),
          })
        }
        return { rows: [] }
      }
      if (sql.includes('FROM generation_input_images') && sql.includes('WHERE id=$1')) {
        const row = rowsById.get(String(params[0]))
        return { rows: row ? [row] : [] }
      }
      if (sql.includes('UPDATE generation_input_images')) {
        const row = rowsById.get(String(params[0]))
        if (row) {
          // The success marker carries its own retirement's updated_at fence.
          if (sql.includes('updated_at=$2') && row.updated_at !== params[1]) return { rows: [] }
          if (sql.includes("status='ready'")) row.status = 'ready'
          if (sql.includes("status='deleted'")) row.status = 'deleted'
          if (sql.includes('object_deleted_at=NULL')) row.object_deleted_at = null
          if (sql.includes('object_deleted_at=now()')) row.object_deleted_at = new Date().toISOString()
          if (sql.includes('SET expires_at')) row.expires_at = new Date(Date.now() + Number(params[2]) * 1000).toISOString()
          if (sql.includes('updated_at=now()')) row.updated_at = new Date().toISOString()
        }
        return { rows: sql.includes('RETURNING updated_at') ? [{ updated_at: row?.updated_at }] : [] }
      }
      return { rows: [] }
    },
  }

  const ports: ImageEditPorts = {
    db: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params })
        if (sql.includes('AS preparation_session')) {
          const scope = options.preparationScope
          const valid = scope && scope.sessionId === params[0] && scope.ownerId === params[1] && !scope.archived
            && (!params[2] || (scope.turnId === params[2] && scope.activeTurnId === params[2] && !scope.cancelled && scope.deadlineLive !== false && !['completed', 'failed', 'cancelled'].includes(scope.status ?? 'running')))
          return { rows: valid ? [{ preparation_session: scope.sessionId }] : [] }
        }
        if (sql.includes('to_regclass')) {
          return { rows: [{ present: options.schemaPresent ?? true }] }
        }
        if (sql.includes('FROM media_uploads') && sql.includes('expires_at::text')) {
          return { rows: [{ expires_at: '2026-11-19 08:00:00+08' }] }
        }
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
        if (sql.includes('FROM generation_jobs')) {
          return { rows: options.existingJob ? [options.existingJob] : [] }
        }
        if (sql.includes('FROM generation_input_images') || sql.includes('FROM media_uploads')) {
          const row = options.uploadRows?.[String(params[0])]
          return { rows: row ? [row] : [] }
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
  }

  const insertsFor = (table: string) => queries.filter(entry => entry.sql.includes(`INSERT INTO ${table}`))
  const sqlFor = (table: string) => queries.filter(entry => entry.sql.includes(table)).map(entry => entry.sql).join('\n')
  return { ports, queries, puts, reads, deletes, insertsFor, sqlFor }
}

const errorOf = async (response: Response): Promise<{ status: number; code: string; message: string }> => {
  const payload = await response.json() as { success: boolean; error?: { code?: string; message?: string } }
  assert.equal(payload.success, false, 'a refused preparation must keep the {success:false,error} envelope')
  const error = payload.error
  assert.ok(error && typeof error.code === 'string' && typeof error.message === 'string', 'a refusal must carry a code and a readable message')
  return { status: response.status, code: error.code, message: error.message }
}

test('storeReadyInputImage writes both rows in lock order and propagates a missing mirror table', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  let mirrorThrows = false
  const client: SqlClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params })
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: ACTOR_ID }] }
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
  assert.deepEqual(queries.map(entry => entry.sql.match(/INSERT INTO (\w+)/)?.[1]).filter(Boolean), ['media_uploads', 'generation_input_images'])
  assert.match(queries[0].sql, /FROM users.*FOR NO KEY UPDATE/)
  const writes = queries.filter(entry => entry.sql.includes('INSERT INTO'))
  assert.equal(writes[0].params[3], 'image/png')
  // Both rows carry the same values after the active-owner lock.
  assert.deepEqual(writes[0].params, writes[1].params)
  assert.equal(writes[1].params[6], bytes.length)
  assert.equal(writes[1].params[8], 86400)
  // The duplicate-safe insert is followed by a read that decides whether the
  // existing row really describes those bytes.
  const verify = queries.find(entry => entry.sql.includes('SELECT') && entry.sql.includes('FROM generation_input_images'))!
  assert.match(verify.sql, /SELECT .+ FROM generation_input_images WHERE id=\$1/)
  assert.deepEqual(verify.params, [row.uploadId])
  // SQL errors abort a real PG transaction; never continue against the legacy table.
  queries.length = 0
  mirrorThrows = true
  await assert.rejects(storeReadyInputImage(client, row), /42P01/)
  assert.equal(queries.length, 2)
  assert.ok(!queries.some(entry => entry.sql.includes('generation_input_images')))
})

test('storeReadyInputImage refuses an existing id whose stored bytes differ', async () => {
  const client: SqlClient = {
    query: async sql => ({
      rows: sql.includes('SELECT')
        ? [{ created_by: ACTOR_ID, object_key: 'inputs/other.png', mime_type: 'image/png', width: 1, height: 1, size_bytes: 1, checksum: 'different' }]
        : [],
    }),
  }
  await assert.rejects(
    storeReadyInputImage(client, {
      uploadId: '55555555-5555-4555-8555-555555555555',
      actorId: ACTOR_ID,
      objectKey: `inputs/${ACTOR_ID}/55555555-5555-4555-8555-555555555555.png`,
      mimeType: 'image/png',
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      sizeBytes: sourcePng.length,
      checksum: sha256(sourcePng),
      ttlSeconds: 86400,
    }),
    /INPUT_ROW_CONFLICT/,
  )
})

/**
 * `POST /api/images/edit/preparations` — the production caller of
 * `prepareImageEditCommand({agentPreparation:true})`.
 *
 * It stages a source and a trusted mask and never becomes a generation: the whole
 * point of the route is that the paid half (approval → job) stays in the Agent
 * flow, so "no job was created" is asserted, not assumed.
 */

const withAgentCore = async (enabled: boolean, run: () => Promise<void>) => {
  const keys = ['AGENT_CORE_ENABLED', 'AGENT_CORE_ADMISSION_READY', 'AGENT_ADMISSION_PERCENT', 'AGENT_ADMISSION_ACTORS'] as const
  const previous = keys.map(key => process.env[key])
  process.env.AGENT_CORE_ENABLED = enabled ? 'true' : 'false'
  process.env.AGENT_CORE_ADMISSION_READY = 'true'
  process.env.AGENT_ADMISSION_PERCENT = '100'
  process.env.AGENT_ADMISSION_ACTORS = ''
  try { await run() } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
  }
}

const preparationFields = (extra: Record<string, string> = {}): FormFields => ({
  modelId: MODEL_ID,
  assetId: ASSET_ID,
  region: JSON.stringify({ x: 100, y: 100, width: 400, height: 300 }),
  idempotencyKey: 'prep-1',
  ...extra,
})

test('preparation is refused as 404 while the Agent namespace is closed', async () => {
  const h = harness()
  await withAgentCore(false, async () => {
    const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields())), h.ports))
    assert.equal(error.status, 404)
    // Closed means closed: no model read, no staged object, no database work.
    assert.deepEqual(h.queries, [])
    assert.deepEqual(h.puts, [])
  })
})

test('preparation refuses a foreign origin and unknown fields before any storage work', async () => {
  await withAgentCore(true, async () => {
    const csrf = harness()
    const csrfError = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields()), { origin: 'https://attacker.example' }), csrf.ports))
    assert.equal(csrfError.code, 'CSRF_REJECTED')
    assert.deepEqual(csrf.puts, [])

    const form = editForm(preparationFields())
    form.append('prompt', 'smuggled')
    const h = harness()
    const error = await errorOf(await prepareAgentImageEdit(editContext(form), h.ports))
    assert.equal(error.code, 'INVALID_INPUT')
    assert.deepEqual(h.queries, [])
    assert.deepEqual(h.puts, [])
  })
})

const ownedPreparationScope = () => ({
  sessionId: '55555555-5555-4555-8555-555555555555', ownerId: ACTOR_ID,
  turnId: '66666666-6666-4666-8666-666666666666', activeTurnId: '66666666-6666-4666-8666-666666666666',
})

test('closed admission rejects legacy and session-only new preparations before database or storage', async () => {
  await withAgentCore(true, async () => {
    process.env.AGENT_CORE_ADMISSION_READY = 'false'
    const contexts: Record<string, string>[] = [{}, { sessionId: ownedPreparationScope().sessionId }]
    for (const context of contexts) {
      const h = harness({ preparationScope: ownedPreparationScope() })
      const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields(context))), h.ports))
      assert.equal(error.status, 503)
      assert.deepEqual(h.queries, [])
      assert.deepEqual(h.puts, [])
    }
  })
})

test('preparation uses the actor rollout and allowlist rather than the namespace flag alone', async () => {
  await withAgentCore(true, async () => {
    process.env.AGENT_ADMISSION_PERCENT = '0'
    const denied = harness()
    assert.equal((await prepareAgentImageEdit(editContext(editForm(preparationFields())), denied.ports)).status, 503)
    assert.deepEqual(denied.puts, [])
    process.env.AGENT_ADMISSION_ACTORS = ACTOR_ID
    const allowed = harness({ preparationScope: ownedPreparationScope() })
    assert.equal((await prepareAgentImageEdit(editContext(editForm(preparationFields({ sessionId: ownedPreparationScope().sessionId }))), allowed.ports)).status, 202)
  })
})

test('an owned active accepted turn can prepare while all new admission is paused', async () => {
  await withAgentCore(true, async () => {
    process.env.AGENT_CORE_ADMISSION_READY = 'false'
    process.env.AGENT_ADMISSION_PERCENT = '0'
    const scope = ownedPreparationScope()
    const h = harness({ preparationScope: scope })
    const response = await prepareAgentImageEdit(editContext(editForm(preparationFields({ sessionId: scope.sessionId, turnId: scope.turnId }))), h.ports)
    assert.equal(response.status, 202)
    const query = h.queries.find(entry => entry.sql.includes('AS preparation_session'))!
    assert.deepEqual(query.params, [scope.sessionId, ACTOR_ID, scope.turnId])
    for (const predicate of ["u.status='active'", 'u.deleted_at IS NULL', 's.archived_at IS NULL', 's.active_turn_id=t.id', "t.status NOT IN ('completed','failed','cancelled')", 't.cancel_requested_at IS NULL', 'clock_timestamp()<t.deadline_at']) assert.ok(query.sql.includes(predicate), predicate)
  })
})

test('foreign, stale and inactive accepted-work context have the same 404 without staging', async () => {
  await withAgentCore(true, async () => {
    process.env.AGENT_CORE_ADMISSION_READY = 'false'
    const scope = ownedPreparationScope()
    const invalidScopes = [
      { ...scope, ownerId: OTHER_USER }, { ...scope, sessionId: OTHER_USER },
      { ...scope, turnId: OTHER_USER }, { ...scope, activeTurnId: OTHER_USER },
      ...['completed', 'failed', 'cancelled'].map(status => ({ ...scope, status })),
      { ...scope, cancelled: true }, { ...scope, deadlineLive: false }, { ...scope, archived: true },
    ]
    for (const preparationScope of invalidScopes) {
      const h = harness({ preparationScope })
      const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields({ sessionId: scope.sessionId, turnId: scope.turnId }))), h.ports))
      assert.equal(error.status, 404)
      assert.equal(error.code, 'NOT_FOUND')
      assert.deepEqual(h.puts, [])
      assert.ok(!h.queries.some(entry => entry.sql.includes('FROM model_configs')))
    }
  })
})

test('preparation rejects malformed, unpaired, binary and duplicate context before database work', async () => {
  await withAgentCore(true, async () => {
    const invalidContexts: Record<string, string>[] = [{ turnId: ownedPreparationScope().turnId }, { sessionId: 'bad' }, { sessionId: '' }, { sessionId: ownedPreparationScope().sessionId, turnId: 'bad' }]
    for (const context of invalidContexts) {
      const h = harness()
      const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields(context))), h.ports))
      assert.equal(error.status, 400)
      assert.deepEqual(h.queries, [])
    }
    for (const duplicate of [false, true]) {
      const form = editForm(preparationFields(duplicate ? { sessionId: ownedPreparationScope().sessionId } : {}))
      if (duplicate) form.append('sessionId', ownedPreparationScope().sessionId)
      else form.append('sessionId', new Blob(['invalid']))
      const h = harness()
      assert.equal((await prepareAgentImageEdit(editContext(form), h.ports)).status, 400)
      assert.deepEqual(h.queries, [])
    }
  })
})

test('a deletion committed before staging prevents new input and provenance writes', async () => {
  await withAgentCore(true, async () => {
    const h = harness({ ownerActive: false })
    const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields())), h.ports))
    assert.equal(error.status, 403)
    assert.deepEqual(h.puts, [])
    assert.equal(h.insertsFor('agent_media_mask_preparations').length, 0)
    assert.equal(h.insertsFor('media_uploads').length, 0)
  })
})

test('preparation without migration 0045 is refused instead of half-staging provenance', async () => {
  await withAgentCore(true, async () => {
    const h = harness({ schemaPresent: false })
    const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields())), h.ports))
    assert.equal(error.status, 503)
    assert.deepEqual(h.puts, [])
  })
})

test('preparation stages source and mask, writes one preparation identity and creates no job', async () => {
  await withAgentCore(true, async () => {
    const h = harness()
    const response = await prepareAgentImageEdit(editContext(editForm(preparationFields())), h.ports)
    assert.equal(response.status, 202)
    const body = await response.json() as { data: Record<string, unknown> }
    assert.equal(body.data.preparationVersion, 1)
    assert.equal(body.data.sourceChecksum, sha256(sourcePng))
    assert.equal(typeof body.data.maskUploadId, 'string')
    assert.deepEqual(body.data.source, { kind: 'asset', id: ASSET_ID })
    assert.equal(body.data.width, SOURCE_WIDTH)
    assert.equal(body.data.height, SOURCE_HEIGHT)
    assert.equal(body.data.expiresAt, '2026-11-19 08:00:00+08')
    // Exactly one provenance row, and the identity it stores is the mask's own bytes.
    const identities = h.insertsFor('agent_media_mask_preparations')
    assert.equal(identities.length, 1)
    assert.equal(identities[0]!.params[2], sha256(sourcePng))
    assert.equal(identities[0]!.params[0], body.data.maskUploadId)
    // The paid half never runs here.
    assert.doesNotMatch(h.queries.map(entry => entry.sql).join('\n'), /INSERT INTO generation_jobs|INSERT INTO outbox_events/)
  })
})

test('preparation is its own rate bucket, not the generation allowance', async () => {
  await withAgentCore(true, async () => {
    const keys: string[] = []
    const h = harness()
    const ports = { ...h.ports, limited: async (key: string) => { keys.push(key); return false } }
    await prepareAgentImageEdit(editContext(editForm(preparationFields())), ports as ImageEditPorts)
    assert.deepEqual(keys, [`agent:preparation:${ACTOR_ID}`])
  })
})

test('preparation rejects a model that cannot accept a mask', async () => {
  await withAgentCore(true, async () => {
    const h = harness({ model: modelRow(noMaskContract) })
    const error = await errorOf(await prepareAgentImageEdit(editContext(editForm(preparationFields())), h.ports))
    assert.equal(error.code, 'MODEL_MASK_NOT_SUPPORTED')
    assert.deepEqual(h.puts, [])
  })
})
