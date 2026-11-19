import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import type pg from 'pg'
import { RUNTIME_SETTINGS_DEFAULTS, type ModelCapabilities } from '../../packages/contracts/src/index'
import { loadMigrations } from '../../packages/database/src/migrations/loader'
import { putReservedImageMask } from '../../apps/api/src/shared/services'
import { createModelConfigRevision } from '../../packages/database/src/repositories/model-config-revisions'
import { createEditMask } from '../../packages/providers/src/index'
import { createGenerationInTransaction, generationCommandError, prepareGeneration, type CreateGenerationCommand } from '../../packages/media-service/src/index'
import { claimKeyedInputRow, type ImageEditPorts } from '../../apps/api/src/modules/image-edit/handlers'
import { createStableUploadIds, prepareImageEdit } from '../../apps/api/src/modules/image-edit/prepare'

const enabled = process.env.MUSECANVAS_AGENT_PG_TEST === '1'
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
// Actual shared creation, input attachment and outbox transactions. No DATABASE_URL,
// settings writes, workers, network providers or S3. Only fresh synthetic IDs.
test('real isolated PG: shared media creation, edit idempotency and object reclamation', {
  skip: enabled ? false : 'Requires explicit owned synthetic PG opt-in; never uses DATABASE_URL', timeout: 180_000,
}, async t => {
  const url = process.env.MUSECANVAS_AGENT_PG_TEST_URL
  assert.equal(url, 'postgresql://fixture@127.0.0.1:35429/musecanvas_ui')
  const { Pool } = require('pg') as typeof import('pg')
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 })
  const actorId = randomUUID(), modelId = randomUUID(), credentialId = randomUUID(), assetId = randomUUID()
  const actor = { id: actorId, email: `${actorId}@example.invalid`, role: 'user' as const, status: 'active' as const, createdAt: new Date().toISOString() }
  const objects = new Map<string, Buffer>()
  const tx = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); t.diagnostic(`Synthetic transaction failure: ${error instanceof Error ? error.message : 'unknown'}`); throw error } finally { client.release() }
  }
  // The Agent media tools call the same two commands the removed HTTP creation
  // route used: prepare, then the transactional write.
  type LocalCommand = Omit<CreateGenerationCommand, 'ownerId'> & { actor: typeof actor }
  type CreateOutcome = { ok: true; id: string } | { ok: false; status: number; code: string }
  const commandPorts = { database: () => pool, runTransaction: tx, runtimeLimits: async () => RUNTIME_SETTINGS_DEFAULTS }
  const create = async (cmd: LocalCommand): Promise<CreateOutcome> => {
    try {
      const { actor: caller, ...command } = cmd
      const prepared = await prepareGeneration({ ...command, ownerId: caller.id }, commandPorts)
      const result = await tx(async client => createGenerationInTransaction(client, prepared))
      return { ok: true, id: String(result.row.id) }
    } catch (error) {
      const { code, status } = generationCommandError(error)
      return { ok: false, status, code }
    }
  }
  const idOf = (outcome: CreateOutcome) => {
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    if (!outcome.ok) throw new Error('creation failed')
    return outcome.id
  }
  const capabilities: ModelCapabilities = { modes: ['text_to_image', 'image_to_image', 'inpaint'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1,
    parameters: [{ name: 'size', type: 'enum', options: ['1024x1024', '1536x1024'], defaultValue: '1024x1024' }, { name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 }],
    inputSlots: [{ role: 'reference_image', minCount: 0, maxCount: 4, required: false, allowedMediaKinds: ['image'] }, { role: 'mask', minCount: 0, maxCount: 1, required: false, allowedMediaKinds: ['image'] }] }
  // Fail before the DML/cleanup scope: a failed Node subtest does not throw
  // through await t.test(), so fixture admission must be a parent assertion.
  try {
    assert.deepEqual((await pool.query('SELECT current_database() AS database,current_user AS actor')).rows[0], { database: 'musecanvas_ui', actor: 'fixture' })
    const expected = loadMigrations().map(migration => migration.version)
    const recorded = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version)
    assert.deepEqual(recorded, expected, 'Prepare the dedicated disposable fixture separately before running media tests')
  } catch (error) {
    await pool.end()
    throw error
  }
  try {
    await tx(async client => {
      await client.query('INSERT INTO users(id,email) VALUES($1,$2)', [actorId, actor.email])
      await client.query("INSERT INTO provider_credentials(id,display_name,adapter,api_key_encrypted,enabled,provider_id,schema_id,created_by) VALUES($1,'Synthetic never decrypt','openai','synthetic-only-not-a-secret',true,'synthetic','synthetic-key-v1',$2)", [credentialId, actorId])
      await client.query("INSERT INTO model_configs(id,display_name,adapter,vendor_model_id,model_kind,sizes,max_count,concurrency_limit,enabled,provider_credential_id,created_by) VALUES($1,'Synthetic command model','openai','synthetic-no-provider','image','[\"1024x1024\",\"1536x1024\"]',1,1,true,$2,$3)", [modelId, credentialId, actorId])
      await createModelConfigRevision(client, { modelId, providerId: 'synthetic', pluginId: 'synthetic', capabilities: capabilities as unknown as Record<string, unknown>, snapshotDigest: 'a'.repeat(64), createdBy: actorId })
    })
    const sourceJob = idOf(await create({ actor, modelId, prompt: 'Synthetic source', parameters: { count: 1, size: '1024x1024' }, normalizedInputs: [], idempotencyKey: `source:${randomUUID()}`, intendedMode: 'text_to_image' }))
    const source = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: { x: 0, y: 0, width: 32, height: 32 } })
    const sourceKey = `synthetic/${actorId}/source.png`; objects.set(sourceKey, source)
    await pool.query("INSERT INTO assets(id,created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum,media_kind) VALUES($1,$2,$3,$4,'image/png',1200,800,$5,$6,'image')", [assetId, actorId, sourceJob, sourceKey, source.length, digest(source)])
    const editPorts: ImageEditPorts = {
      db: () => pool, runTransaction: fn => tx(async client => { await fn(client) }), limited: async () => false,
      readObjectBytes: async key => { assert.ok(objects.has(key)); return objects.get(key)! },
      putObjectBytes: async (key, bytes) => {
        const existing = objects.get(key)
        // Deterministic keyed staging may re-PUT the same key on a retry; a
        // differing payload under one key would still be a real bug.
        if (existing) assert.deepEqual(Buffer.from(bytes), existing)
        else objects.set(key, Buffer.from(bytes))
      },
      putReservedMask: async (key, bytes) => putReservedImageMask(key, bytes, { bucket: 'fixture', put: async command => {
        assert.equal(command.input.IfNoneMatch, '*'); if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } }; objects.set(key, Buffer.from(bytes))
      }, read: async () => { assert.ok(objects.has(key)); return objects.get(key)! } }), deleteObject: async key => { objects.delete(key) },
      uploadLimits: async () => ({ maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes, uploadTtlSeconds: 3600 }),
    }
    const prepared = await prepareImageEdit({ actor, modelId, prompt: 'Replace selected area', parameters: { count: 1 }, assetId, selection: { x: -10, y: 15, width: 130, height: 100 }, ports: editPorts })
    assert.equal(prepared.success, true); if (!prepared.success) throw new Error('prepare failed')
    const frozen = (await prepareGeneration({ ownerId: actorId, modelId, prompt: prepared.data.prompt,
      parameters: prepared.data.parameters, normalizedInputs: prepared.data.inputs, intendedMode: 'inpaint',
      idempotencyKey: `prepared:${randomUUID()}` }, { database: () => pool, runtimeLimits: async () => RUNTIME_SETTINGS_DEFAULTS })).snapshot.normalized
    assert.equal(frozen.mode, 'inpaint'); assert.deepEqual(frozen.parameters, { size: '1536x1024', count: 1 })
    assert.deepEqual(prepared.data.selection, { x: 0, y: 15, width: 120, height: 100 })
    const maskId = frozen.inputs[1]!.uploadId!
    const maskRow = (await pool.query('SELECT * FROM media_uploads WHERE id=$1', [maskId])).rows[0]
    assert.equal(maskRow.checksum, digest(objects.get(maskRow.object_key)!)); assert.equal(maskRow.width, 1200); assert.equal(maskRow.height, 800)
    assert.equal((await pool.query('SELECT count(*) FROM media_uploads WHERE created_by=$1', [actorId])).rows[0].count, '1', 'gallery source is never mirrored')
    const cmd: LocalCommand = { actor, modelId, prompt: frozen.prompt, parameters: frozen.parameters,
      normalizedInputs: frozen.inputs, intendedMode: frozen.mode, idempotencyKey: `prepared-edit:${randomUUID()}` }
    let jobId = ''
    await t.test('shared creation attaches prepared inputs and replays the exact committed payload', async () => {
      jobId = idOf(await create(cmd))
      assert.equal((await pool.query('SELECT attached_job_id FROM media_uploads WHERE id=$1', [maskId])).rows[0].attached_job_id, jobId)
      assert.deepEqual((await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [jobId])).rows[0].normalized_request,
        { modelId, prompt: frozen.prompt, parameters: frozen.parameters, inputs: frozen.inputs, mode: frozen.mode })
      assert.equal(idOf(await create(cmd)), jobId)
    })
    await t.test('same-key different full payload conflicts; duplicate replays leave exactly one job/outbox', async () => {
      for (const patch of [{ prompt: 'changed' }, { parameters: { ...frozen.parameters, size: '1024x1024' } },
        { normalizedInputs: [{ ...frozen.inputs[0]!, position: 1 }, { ...frozen.inputs[1]!, position: 0 }] }]) {
        const outcome = await create({ ...cmd, ...patch })
        assert.equal(outcome.ok, false)
        assert.equal(!outcome.ok && outcome.code, 'IDEMPOTENCY_CONFLICT')
      }
      const replay = await Promise.all([create(cmd), create(cmd)])
      for (const outcome of replay) assert.equal(idOf(outcome), jobId)
      assert.equal((await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, cmd.idempotencyKey])).rows[0].count, '1')
      assert.equal((await pool.query("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND event_type='generation.requested'", [jobId])).rows[0].count, '1')
      assert.equal(objects.size, 2, 'replay never prepares a new mask')
    })
    await t.test('concurrent initial shared creates compare the ON CONFLICT winner, not an echo', async () => {
      const key = `concurrent:${randomUUID()}`, base = { actor, modelId, parameters: { count: 1, size: '1024x1024' }, normalizedInputs: [], intendedMode: 'text_to_image' as const, idempotencyKey: key }
      // Hold the model lock so both initial existing-job reads see no row.
      const blocker = await pool.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM model_configs WHERE id=$1 FOR UPDATE', [modelId])
      try {
        const a = create({ ...base, prompt: 'winner A' }), b = create({ ...base, prompt: 'winner B' })
        let waiting = 0
        for (let i = 0; i < 50 && waiting < 2; i++) {
          await new Promise(resolve => setTimeout(resolve, 50))
          waiting = Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT m.%'", [])).rows[0].count)
        }
        assert.ok(waiting >= 2, 'both actual transactions waited after their initial no-job read')
        await blocker.query('COMMIT')
        const outcomes = await Promise.all([a, b]); assert.deepEqual(outcomes.map(outcome => outcome.ok).sort(), [false, true])
        const winner = idOf(outcomes.find(outcome => outcome.ok)!)
        assert.equal((await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, key])).rows[0].count, '1')
        assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [winner])).rows[0].count, '1')
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    })

    await t.test('real shared command covers reference image and both video modes including first/last roles', async () => {
      const imageId = idOf(await create({ actor, modelId, prompt: 'Synthetic reference', parameters: frozen.parameters, normalizedInputs: [{ assetId, role: 'reference_image', position: 0 }], intendedMode: 'image_to_image', idempotencyKey: `reference:${randomUUID()}` }))
      assert.equal((await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [imageId])).rows[0].normalized_request.mode, 'image_to_image')
      const videoModel = randomUUID(), tailId = randomUUID()
      const videoCaps: ModelCapabilities = { modes: ['text_to_video', 'image_to_video'], supportedMediaKinds: ['video'], declaredBy: 'plugin-manifest', parameters: [],
        inputSlots: ['first_frame', 'last_frame'].map(role => ({ role, required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] })) }
      await tx(async client => {
        await client.query("INSERT INTO model_configs(id,display_name,adapter,vendor_model_id,model_kind,sizes,max_count,concurrency_limit,enabled,provider_credential_id,created_by) VALUES($1,'Synthetic video model','openai','synthetic-no-provider','video','[]',1,1,true,$2,$3)", [videoModel, credentialId, actorId])
        await createModelConfigRevision(client, { modelId: videoModel, providerId: 'synthetic', pluginId: 'synthetic', capabilities: videoCaps as unknown as Record<string, unknown>, snapshotDigest: 'c'.repeat(64), createdBy: actorId })
        await client.query("INSERT INTO assets(id,created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum,media_kind) VALUES($1,$2,$3,$4,'image/png',1200,800,$5,$6,'image')", [tailId, actorId, sourceJob, `synthetic/${actorId}/tail.png`, source.length, digest(source)])
      })
      for (const inputs of [[], [{ assetId, role: 'first_frame', position: 0 }, { assetId: tailId, role: 'last_frame', position: 1 }]]) {
        const mode = inputs.length ? 'image_to_video' : 'text_to_video'
        const id = idOf(await create({ actor, modelId: videoModel, prompt: 'Synthetic video', parameters: {}, normalizedInputs: inputs,
          intendedMode: mode, idempotencyKey: `video:${randomUUID()}` }))
        const payload = (await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [id])).rows[0].normalized_request
        assert.deepEqual(payload, { modelId: videoModel, prompt: 'Synthetic video', parameters: {}, inputs, mode })
        assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [id])).rows[0].count, '1')
      }
      for (const bad of [{ normalizedInputs: [{ assetId, role: 'reference_image', position: 0 }], intendedMode: 'inpaint' as const }, { normalizedInputs: [{ assetId, role: 'mask', position: 0 }], intendedMode: 'inpaint' as const }]) {
        const outcome = await create({ actor, modelId, prompt: 'Invalid edit', parameters: frozen.parameters, idempotencyKey: `invalid:${randomUUID()}`, ...bad })
        assert.equal(!outcome.ok && outcome.status, 400)
      }
    })
    await t.test('actual bundled descriptor inpainting flags reach frozen inpaint job, absent intent stays manual', async () => {
      const { resolvePresetCapabilities } = await import('../../apps/api/src/admin/model-presets')
      const preset = await resolvePresetCapabilities('openai-image', '1.1.0', 'gpt-image-2')
      await tx(client => createModelConfigRevision(client, { modelId, providerId: 'synthetic', pluginId: 'synthetic', capabilities: preset.capabilities as unknown as Record<string, unknown>, snapshotDigest: 'b'.repeat(64), createdBy: actorId }))
      const edit = await prepareImageEdit({ actor, modelId, prompt: 'Legacy declared edit', assetId, selection: { x: 0, y: 0, width: 100, height: 100 }, ports: editPorts })
      assert.equal(edit.success, true); if (!edit.success) throw new Error('legacy prepare')
      const legacyCommand = { actor, modelId, prompt: edit.data.prompt, parameters: edit.data.parameters,
        normalizedInputs: edit.data.inputs, intendedMode: 'inpaint' as const, idempotencyKey: `legacy:${randomUUID()}` }
      const createdId = idOf(await create(legacyCommand))
      assert.equal((await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [createdId])).rows[0].normalized_request.mode, 'inpaint')
      assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [createdId])).rows[0].count, '1')
      const { intendedMode: _, ...manual } = legacyCommand
      const outcome = await create(manual)
      assert.equal(!outcome.ok && outcome.status, 409, 'absent internal intent still derives legacy image_to_image and conflicts with frozen inpaint')
      assert.equal(!outcome.ok && outcome.code, 'IDEMPOTENCY_CONFLICT')
    })
    await t.test('keyed claim takes the same media-first lock order as attach', async () => {
      const region = { x: 15, y: 15, width: 48, height: 48 }
      const key = `lock-order:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const maskId = createStableUploadIds(`${actorId}:${key}`).derive('mask', digest(maskBytes))
      const row = { uploadId: maskId, actorId, objectKey: `inputs/${actorId}/${maskId}.png`, mimeType: 'image/png', width: 1200, height: 800, sizeBytes: maskBytes.length, checksum: digest(maskBytes), ttlSeconds: 3600 }
      await tx(client => claimKeyedInputRow(client, row))
      // An attach-shaped transaction takes the media lock first, then the legacy
      // lock; a claim that inverted the order would deadlock this interleaving.
      // The barrier is a real lock wait: the claim must be observed blocked while
      // media is held, not a timing guess.
      let mediaLocked = false
      const waitForBlockedClaim = async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const waiting = (await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%media_uploads%'")).rows[0].count as number
          if (waiting > 0) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('the concurrent claim never blocked on the media lock')
      }
      const attaching = tx(async client => {
        await client.query('SELECT id FROM media_uploads WHERE id=$1 FOR UPDATE', [maskId])
        mediaLocked = true
        await waitForBlockedClaim()
        await client.query('SELECT id FROM generation_input_images WHERE id=$1 FOR UPDATE', [maskId])
      })
      while (!mediaLocked) await new Promise(resolve => setTimeout(resolve, 10))
      const claiming = tx(client => claimKeyedInputRow(client, row))
      await Promise.all([attaching, claiming])
    })
  } finally {
    // Every delete is bounded by a brand-new actor. No baseline rows touched.
    try { await tx(async client => {
      await client.query('DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM generation_jobs WHERE created_by=$1)', [actorId])
      await client.query('DELETE FROM generation_job_inputs WHERE job_id IN (SELECT id FROM generation_jobs WHERE created_by=$1)', [actorId])
      await client.query('DELETE FROM assets WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM media_uploads WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM generation_input_images WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM generation_jobs WHERE created_by=$1', [actorId])
      await client.query('UPDATE model_configs SET latest_revision_id=NULL WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM model_config_revisions WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM model_configs WHERE created_by=$1', [actorId])
      await client.query('DELETE FROM provider_credentials WHERE id=$1 AND created_by=$2', [credentialId, actorId])
      await client.query('DELETE FROM users WHERE id=$1', [actorId])
    }) } finally { await pool.end() }
  }
})
