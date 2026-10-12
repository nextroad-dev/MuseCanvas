import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import type pg from 'pg'
import { CANVAS_AGENT_SETTINGS_DEFAULTS, RUNTIME_SETTINGS_DEFAULTS, type JsonObject, type ModelCapabilities } from '../../packages/contracts/src/index'
import * as repo from '../../packages/database/src/repositories/canvas-agent'
import * as preparationRepo from '../../packages/database/src/repositories/canvas-agent-preparations'
import { runMigrations } from '../../packages/database/src/migrations/runner'
import { executeTool } from '../../apps/api/src/modules/canvases/agent/tools'
import { putReservedImageMask } from '../../apps/api/src/shared/services'
import { createModelConfigRevision } from '../../packages/database/src/repositories/model-config-revisions'
import { createEditMask } from '../../packages/providers/src/index'
import { createGenerationJob, type GenerationJobPorts, type CreateGenerationJobCommand } from '../../apps/api/src/modules/generations/create-job'
import { claimKeyedInputRow, editImage, type ImageEditPorts } from '../../apps/api/src/modules/image-edit/handlers'
import type { AuthedContext } from '../../apps/api/src/router/types'
import { createStableUploadIds, prepareImageEdit } from '../../apps/api/src/modules/image-edit/prepare'
import { normalizeSubmissionRequest } from '../../apps/api/src/modules/canvases/agent/normalization'
import { PgAgentStore, type RunContext } from '../../apps/api/src/modules/canvases/agent/store'
import { submitPending } from '../../apps/api/src/modules/canvases/agent/submit'

const enabled = process.env.MUSECANVAS_AGENT_PG_TEST === '1'
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
// Actual shared creation, input attachment and outbox transactions. No DATABASE_URL,
// settings writes, workers, network providers or S3. Only fresh synthetic IDs.
test('real isolated PG: Agent frozen payload through shared generation command', {
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
  const ports: GenerationJobPorts = {
    database: () => pool, runTransaction: tx, runtimeLimits: async () => RUNTIME_SETTINGS_DEFAULTS,
    // The response serializer is the ONLY fake creation boundary: avoids S3 signing.
    jobDto: async row => ({ id: row.id }) as any,
  }
  const create = (cmd: CreateGenerationJobCommand) => createGenerationJob(cmd, ports)
  const envelope = async (response: Awaited<ReturnType<typeof create>>) => {
    const body = await response.json(); assert.equal(response.status, 202, JSON.stringify(body)); assert.equal(body.success, true); return body.data.id as string
  }
  const capabilities: ModelCapabilities = { modes: ['text_to_image', 'image_to_image', 'inpaint'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1,
    parameters: [{ name: 'size', type: 'enum', options: ['1024x1024', '1536x1024'], defaultValue: '1024x1024' }, { name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 }],
    inputSlots: [{ role: 'reference_image', minCount: 0, maxCount: 4, required: false, allowedMediaKinds: ['image'] }, { role: 'mask', minCount: 0, maxCount: 1, required: false, allowedMediaKinds: ['image'] }] }
  const store = new PgAgentStore(tx)
  let scope: repo.CanvasAgentScope | undefined
  try {
    assert.deepEqual((await pool.query('SELECT current_database() AS database,current_user AS actor')).rows[0], { database: 'musecanvas_ui', actor: 'fixture' })
    await t.test('0033 only upgrade, runner rerun0, direct SQL rerun; recorded0001-0032 untouched', async () => {
      const before = (await pool.query("SELECT * FROM schema_migrations WHERE version<='0032' ORDER BY version")).rows
      assert.equal(before.length, 32)
      const applied = await runMigrations({ pool }); assert.ok(applied.applied.length === 0 || JSON.stringify(applied.applied) === '["0033"]')
      assert.deepEqual((await runMigrations({ pool })).applied, [])
      const sql = await readFile(new URL('../../packages/database/migrations/0033_canvas_agent_preparations.sql', import.meta.url), 'utf8')
      await tx(async client => { await client.query(sql) })
      assert.deepEqual((await pool.query("SELECT * FROM schema_migrations WHERE version<='0032' ORDER BY version")).rows, before)
      t.diagnostic(`Actual migration applied: ${JSON.stringify(applied.applied)}; rerun0; direct0033 rerun passed`)
    })
    await tx(async client => {
      await client.query('INSERT INTO users(id,email) VALUES($1,$2)', [actorId, actor.email])
      await client.query("INSERT INTO provider_credentials(id,display_name,adapter,api_key_encrypted,enabled,provider_id,schema_id,created_by) VALUES($1,'Synthetic never decrypt','openai','synthetic-only-not-a-secret',true,'synthetic','synthetic-key-v1',$2)", [credentialId, actorId])
      await client.query("INSERT INTO model_configs(id,display_name,adapter,vendor_model_id,model_kind,sizes,max_count,concurrency_limit,enabled,provider_credential_id,created_by) VALUES($1,'Synthetic command model','openai','synthetic-no-provider','image','[\"1024x1024\",\"1536x1024\"]',1,1,true,$2,$3)", [modelId, credentialId, actorId])
      await createModelConfigRevision(client, { modelId, providerId: 'synthetic', pluginId: 'synthetic', capabilities: capabilities as unknown as Record<string, unknown>, snapshotDigest: 'a'.repeat(64), createdBy: actorId })
    })
    const sourceJob = await envelope(await create({ actor, modelId, prompt: 'Synthetic source', parameters: { count: 1, size: '1024x1024' }, normalizedInputs: [], idempotencyKey: `source:${randomUUID()}`, intendedMode: 'text_to_image' }))
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
      uploadLimits: async () => ({ maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes, uploadTtlSeconds: 3600 }), createJob: create,
    }
    const prepared = await prepareImageEdit({ actor, modelId, prompt: 'Replace selected area', parameters: { count: 1 }, assetId, selection: { x: -10, y: 15, width: 130, height: 100 }, ports: editPorts })
    assert.equal(prepared.success, true); if (!prepared.success) throw new Error('prepare failed')
    const model = await store.mediaModel(modelId, 'image')
    const frozen = normalizeSubmissionRequest({ capabilities: model.capabilities, defaults: model.defaults as any,
      request: { modelId, prompt: prepared.data.prompt, parameters: prepared.data.parameters as JsonObject, inputs: prepared.data.inputs }, kind: 'image', signal: new AbortController().signal, deadline: Date.now() + 120000 })
    assert.equal(frozen.mode, 'inpaint'); assert.deepEqual(frozen.parameters, { size: '1536x1024', count: 1 })
    assert.deepEqual(prepared.data.selection, { x: 0, y: 15, width: 120, height: 100 })
    const maskId = frozen.inputs[1]!.uploadId!
    const maskRow = (await pool.query('SELECT * FROM media_uploads WHERE id=$1', [maskId])).rows[0]
    assert.equal(maskRow.checksum, digest(objects.get(maskRow.object_key)!)); assert.equal(maskRow.width, 1200); assert.equal(maskRow.height, 800)
    assert.equal((await pool.query('SELECT count(*) FROM media_uploads WHERE created_by=$1', [actorId])).rows[0].count, '1', 'gallery source is never mirrored')
    const run = await tx(async client => {
      const canvasId = (await client.query("INSERT INTO canvas_documents(created_by,title) VALUES($1,'Synthetic tools') RETURNING id", [actorId])).rows[0].id
      const session = await repo.getOrCreateCanvasAgentSession(client, { actorId, canvasId }); assert.ok(session)
      scope = { actorId, canvasId, sessionId: session.id }
      const snapshot: JsonObject = { kind: 'user', text: 'Synthetic edit', messageId: randomUUID(), baseRevision: 1, requireConfirmation: true, sceneCommitMode: 'agent-managed' }
      const claim = await repo.beginCanvasAgentTurn(client, scope, { messageId: String(snapshot.messageId), requestDigest: repo.canvasAgentRequestDigest(snapshot), requestSnapshot: snapshot, timeoutMs: 120000 }, { role: 'user', content: 'Synthetic edit' })
      assert.equal(claim.status, 'claimed'); if (claim.status !== 'claimed') throw new Error('turn')
      return { scope, lease: { turnId: claim.turn.id, leaseToken: claim.turn.leaseToken } }
    })
    const ctx = { ...run, canvas: { revision: 1, scene: { nodes: [], edges: [] } }, settings: { ...CANVAS_AGENT_SETTINGS_DEFAULTS, maxJobsPerTurn: 1 }, deadline: Date.now() + 120000 } as RunContext
    const toolCallId = `${run.lease.turnId}:synthetic-edit`, ids = repo.canvasAgentPendingIdentity(run.scope.canvasId, toolCallId)
    const pendingInput = { toolCallId, kind: 'image' as const, prompt: frozen.prompt, modelId, parameters: frozen.parameters, sourceNodeId: null, sourceAssetId: assetId,
      baseRevision: 1, expiresAt: new Date(Date.now() + 600000).toISOString(), modelConfigDigest: model.digest, requestVersion: 2 as const,
      normalizedRequest: { modelId, prompt: frozen.prompt, parameters: frozen.parameters, inputs: frozen.inputs, mode: frozen.mode } as unknown as JsonObject, normalizedInputs: frozen.inputs,
      editMetadata: { sourceWidth: 1200, sourceHeight: 800, selection: prepared.data.selection! },
      ops: [{ type: 'add_node' as const, node: { id: ids.nodeId, type: 'image' as const, position: { x: 0, y: 0 }, data: { prompt: frozen.prompt } } }] }
    const pending = await store.pending(ctx, pendingInput)
    await t.test('pending reentry preserves frozen input/expiry even at one-job budget', async () => {
      assert.deepEqual(await store.pending(ctx, pendingInput), pending)
      await assert.rejects(store.pending(ctx, { ...pendingInput, prompt: 'different' }))
    })
    const cmd: CreateGenerationJobCommand = { actor, modelId, prompt: frozen.prompt, parameters: frozen.parameters, normalizedInputs: frozen.inputs, intendedMode: frozen.mode, idempotencyKey: pending.idempotencyKey }
    let jobId = ''
    await t.test('create-attach crash, expired lease and lost response recover actual matching attached job', async () => {
      const claim = await tx(client => repo.claimCanvasAgentPendingJob(client, run.scope, pending.id, 1000)); assert.equal(claim.status, 'claimed')
      jobId = await envelope(await create(cmd)) // committed create; deliberately no pending.complete
      assert.equal((await pool.query('SELECT status,attached_job_id FROM media_uploads WHERE id=$1', [maskId])).rows[0].attached_job_id, jobId)
      const payload = (await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [jobId])).rows[0].normalized_request
      assert.deepEqual(payload, pendingInput.normalizedRequest)
      assert.equal(await envelope(await create(cmd)), jobId, 'attached inputs must not block same-payload recovery')
      await pool.query("UPDATE canvas_agent_pending_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [pending.id])
      // Runtime/LLM configuration is fake; claim/complete, inputs and create are actual PG commands.
      const confirmationStore = { claim: async () => {
        const c = await tx(client => repo.claimCanvasAgentPendingJob(client, run.scope, pending.id, 120000))
        assert.equal(c.status, 'claimed'); if (c.status !== 'claimed') throw new Error('claim')
        return { scope: run.scope, pending: c.pending, claimed: true }
      }, complete: store.complete.bind(store) } as any
      const submitted = await submitPending(confirmationStore, actor, run.scope.canvasId, { pendingId: pending.id, approve: true }, create, new AbortController().signal, 120000)
      assert.equal(submitted.jobId, jobId); assert.equal(submitted.status, 'submitted')
    })
    await t.test('new proposal cannot drop/swap an inherited already-attached explicit upload', async () => {
      const explicit = { ...ctx, settings: { ...ctx.settings, maxJobsPerTurn: 2 }, requireConfirmation: true, context: { modelId, parameters: frozen.parameters, inputs: frozen.inputs } }
      const call = { id: 'attached-explicit-input', name: 'generate_image', arguments: { modelId, prompt: 'New proposal' } }
      await assert.rejects(executeTool({ store, ctx: explicit, actor, call, scene: ctx.canvas.scene, signal: new AbortController().signal, create }), /SOURCE_NOT_READY/)
      const identity = repo.canvasAgentPendingIdentity(run.scope.canvasId, `${run.lease.turnId}:${call.id}`)
      assert.equal((await pool.query('SELECT count(*) FROM canvas_agent_pending_jobs WHERE id=$1', [identity.id])).rows[0].count, '0')
      assert.equal((await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, pending.idempotencyKey])).rows[0].count, '1')
    })
    await t.test('same-key different full payload conflicts; duplicate replays leave exactly one job/outbox', async () => {
      for (const patch of [{ prompt: 'changed' }, { parameters: { ...frozen.parameters, size: '1024x1024' } }, { normalizedInputs: [{ ...frozen.inputs[0]!, position: 1 }, { ...frozen.inputs[1]!, position: 0 }] }]) {
        const response = await create({ ...cmd, ...patch }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT')
      }
      const replay = await Promise.all([create(cmd), create(cmd)]); for (const response of replay) assert.equal(await envelope(response), jobId)
      assert.equal((await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, cmd.idempotencyKey])).rows[0].count, '1')
      assert.equal((await pool.query("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND event_type='generation.requested'", [jobId])).rows[0].count, '1')
      assert.equal(objects.size, 2, 'confirmation never prepares a new mask')
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
        const responses = await Promise.all([a, b]); assert.deepEqual(responses.map(r => r.status).sort(), [202, 409])
        const winner = await envelope(responses.find(r => r.status === 202)!)
        assert.equal((await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, key])).rows[0].count, '1')
        assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [winner])).rows[0].count, '1')
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    })

    await t.test('actual edit tool crash after ready before pending reuses frozen snapshot/checksum/expiry without preparation', async () => {
      const editContext = { ...ctx, context: { intent: 'edit' as const, modelId, parameters: { count: 1 }, editSource: { assetId, selection: { x: -10, y: 15, width: 130, height: 100 } } }, requireConfirmation: true,
        settings: { ...ctx.settings, maxJobsPerTurn: 8 } }
      const call = { id: 'ready-before-pending', name: 'edit_image', arguments: { modelId, prompt: 'Frozen recovery', selection: editContext.context.editSource.selection } }
      let preparations = 0, crash = true
      const pendingMethod = store.pending.bind(store)
      store.pending = async (...args) => { if (crash) { crash = false; throw new Error('synthetic crash before pending') }; return pendingMethod(...args) }
      const tool = () => executeTool({ store, ctx: editContext, actor, call, scene: editContext.canvas.scene, signal: new AbortController().signal, create,
        prepare: async input => { preparations++; return prepareImageEdit({ ...input, ports: editPorts }) } })
      try {
        await assert.rejects(tool(), /synthetic crash/)
        const saved = (await pool.query('SELECT * FROM canvas_agent_preparations WHERE turn_id=$1 AND tool_call_id=$2', [run.lease.turnId, `${run.lease.turnId}:${call.id}`])).rows[0]
        assert.equal(saved.status, 'ready'); assert.equal(preparations, 1)
        const result = await tool(); assert.equal(preparations, 1)
        assert.equal(result.pending!.expiresAt, new Date(saved.expires_at).toISOString())
        assert.deepEqual(result.pending!.normalizedRequest, saved.ready_snapshot.normalizedRequest)
        assert.equal(result.pending!.normalizedInputs![1]!.uploadId, saved.mask_upload_id)
        assert.equal((await pool.query('SELECT checksum FROM media_uploads WHERE id=$1', [saved.mask_upload_id])).rows[0].checksum, saved.artifact.checksum)
        for (const sql of ["UPDATE canvas_agent_preparations SET expires_at=expires_at+interval '1 second' WHERE id=$1", "UPDATE canvas_agent_preparations SET artifact=jsonb_set(artifact,'{checksum}',to_jsonb(repeat('b',64))) WHERE id=$1", "UPDATE canvas_agent_preparations SET ready_snapshot=jsonb_set(ready_snapshot,'{normalizedRequest,prompt}',to_jsonb('changed'::text)) WHERE id=$1"]) {
          await assert.rejects(tx(async client => { await client.query(sql, [saved.id]) }), /immutable/)
        }
        const changed = { ...call, arguments: { ...call.arguments, prompt: 'changed' } }
        await assert.rejects(executeTool({ store, ctx: editContext, actor, call: changed, scene: editContext.canvas.scene, signal: new AbortController().signal, create }), /CONFLICT/)
      } finally { store.pending = pendingMethod }
    })
    await t.test('crash after immutable object before ready rows: lease reentry reuses original mask and stale writer is fenced', async () => {
      const editContext = { ...ctx, requireConfirmation: true, settings: { ...ctx.settings, maxJobsPerTurn: 8 } }
      const call = { id: 'object-before-input', name: 'edit_image', arguments: { modelId, prompt: 'Object crash', sourceAssetId: assetId, selection: { x: 0, y: 0, width: 120, height: 100 } } }
      const stage = store.stageEditMask.bind(store)
      let old: preparationRepo.CanvasAgentEditPreparation | undefined, oldRow: any, count = 0
      store.stageEditMask = async (context, reservation, row, put) => {
        old = reservation; oldRow = row
        await stage(context, reservation, row, async () => { await put(); throw new Error('synthetic crash after object') })
      }
      const tool = () => executeTool({ store, ctx: editContext, actor, call, scene: editContext.canvas.scene, signal: new AbortController().signal, create,
        prepare: async input => { count++; return prepareImageEdit({ ...input, ports: editPorts }) } })
      try { await assert.rejects(tool()) } finally { store.stageEditMask = stage }
      assert.ok(old); assert.equal((await pool.query('SELECT status FROM media_uploads WHERE id=$1', [old.maskUploadId])).rows[0].status, 'pending', 'pre-write TTL row survives the crash without claiming ready bytes')
      const expiry = old.expiresAt
      await pool.query("UPDATE canvas_agent_preparations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id])
      const recovered = await tool(); assert.equal(count, 2)
      assert.equal(recovered.pending!.expiresAt, expiry); assert.equal(recovered.pending!.normalizedInputs![1]!.uploadId, old.maskUploadId)
      let stalePuts = 0
      await assert.rejects(stage(editContext, old, oldRow, async () => { stalePuts++ }))
      assert.equal(stalePuts, 0, 'stale worker cannot overwrite the object or ready input')
      const command = { actor, modelId, prompt: recovered.pending!.prompt, parameters: recovered.pending!.parameters, normalizedInputs: recovered.pending!.normalizedInputs!, intendedMode: 'inpaint' as const, idempotencyKey: recovered.pending!.idempotencyKey }
      const createdId = await envelope(await create(command))
      await assert.rejects(stage(editContext, old, oldRow, async () => { stalePuts++ }))
      assert.equal((await pool.query('SELECT status,attached_job_id FROM media_uploads WHERE id=$1', [old.maskUploadId])).rows[0].attached_job_id, createdId)
      assert.equal(stalePuts, 0)
    })
    await t.test('simultaneous same edit calls have one scoped preparation; different identity and expired preparation refuse', async () => {
      const editContext = { ...ctx, requireConfirmation: true, settings: { ...ctx.settings, maxJobsPerTurn: 8 } }
      const call = { id: 'simultaneous-preparation', name: 'edit_image', arguments: { modelId, prompt: 'Concurrent mask', sourceAssetId: assetId, selection: { x: 0, y: 0, width: 120, height: 100 } } }
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
      let prepares = 0
      const tool = () => executeTool({ store, ctx: editContext, actor, call, scene: editContext.canvas.scene, signal: new AbortController().signal, create,
        prepare: async input => { prepares++; entered(); await gate; return prepareImageEdit({ ...input, ports: editPorts }) } })
      const first = tool(); await started
      try { await assert.rejects(tool(), /BUSY/) } finally { release() }
      const result = await first; assert.equal(prepares, 1)
      assert.equal((await pool.query('SELECT count(*) FROM canvas_agent_preparations WHERE turn_id=$1 AND tool_call_id=$2', [run.lease.turnId, `${run.lease.turnId}:${call.id}`])).rows[0].count, '1')
      const record = (await pool.query('SELECT * FROM canvas_agent_preparations WHERE turn_id=$1 AND tool_call_id=$2', [run.lease.turnId, `${run.lease.turnId}:${call.id}`])).rows[0]
      await assert.rejects(store.reserveEdit(editContext, record.tool_call_id, { ...record.request_snapshot, prompt: 'different' }), /CONFLICT/)
      const expiresCall = `${run.lease.turnId}:expired-reservation`
      const identity = { ...record.request_snapshot, prompt: 'Expired reservation' }
      const short = await tx(client => preparationRepo.reserveCanvasAgentEditPreparation(client, run.scope, run.lease, { toolCallId: expiresCall, requestSnapshot: identity, leaseMs: 1000, ttlSeconds: 1 }))
      await new Promise(resolve => setTimeout(resolve, 1100))
      await assert.rejects(store.reserveEdit(editContext, expiresCall, identity), /EXPIRED/)
      assert.equal((await pool.query('SELECT count(*) FROM media_uploads WHERE id=$1', [short.maskUploadId])).rows[0].count, '0')
      assert.deepEqual((await pool.query("SELECT canvas_agent_valid_preparation_artifact('null'::jsonb) AS artifact,canvas_agent_valid_preparation_snapshot('null'::jsonb,$1,$2::jsonb) AS snapshot", [short.maskUploadId, JSON.stringify(identity)])).rows[0], { artifact: false, snapshot: false })
      assert.ok(result.pending)
    })
    await t.test('real shared command covers reference image and both video modes including first/last roles', async () => {
      const imageId = await envelope(await create({ actor, modelId, prompt: 'Synthetic reference', parameters: frozen.parameters, normalizedInputs: [{ assetId, role: 'reference_image', position: 0 }], intendedMode: 'image_to_image', idempotencyKey: `reference:${randomUUID()}` }))
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
        const request = normalizeSubmissionRequest({ capabilities: videoCaps, defaults: {}, request: { modelId: videoModel, prompt: 'Synthetic video', parameters: {}, inputs }, kind: 'video', signal: new AbortController().signal, deadline: Date.now() + 120000 })
        const id = await envelope(await create({ actor, modelId: videoModel, prompt: request.prompt, parameters: request.parameters, normalizedInputs: request.inputs, intendedMode: request.mode, idempotencyKey: `video:${randomUUID()}` }))
        const payload = (await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [id])).rows[0].normalized_request
        assert.deepEqual(payload, { modelId: videoModel, prompt: request.prompt, parameters: request.parameters, inputs: request.inputs, mode: request.mode })
        assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [id])).rows[0].count, '1')
      }
      for (const bad of [{ normalizedInputs: [{ assetId, role: 'reference_image', position: 0 }], intendedMode: 'inpaint' as const }, { normalizedInputs: [{ assetId, role: 'mask', position: 0 }], intendedMode: 'inpaint' as const }]) {
        const response = await create({ actor, modelId, prompt: 'Invalid edit', parameters: frozen.parameters, idempotencyKey: `invalid:${randomUUID()}`, ...bad })
        assert.equal(response.status, 400)
      }
    })
    await t.test('actual bundled descriptor inpainting flags reach frozen inpaint job, absent intent stays manual', async () => {
      const { resolvePresetCapabilities } = await import('../../apps/api/src/admin/model-presets')
      const preset = await resolvePresetCapabilities('openai-image', '1.1.0', 'gpt-image-2')
      await tx(client => createModelConfigRevision(client, { modelId, providerId: 'synthetic', pluginId: 'synthetic', capabilities: preset.capabilities as unknown as Record<string, unknown>, snapshotDigest: 'b'.repeat(64), createdBy: actorId }))
      const edit = await prepareImageEdit({ actor, modelId, prompt: 'Legacy declared edit', assetId, selection: { x: 0, y: 0, width: 100, height: 100 }, ports: editPorts })
      assert.equal(edit.success, true); if (!edit.success) throw new Error('legacy prepare')
      const normalized = normalizeSubmissionRequest({ capabilities: preset.capabilities, defaults: {}, request: { modelId, prompt: edit.data.prompt, parameters: edit.data.parameters as JsonObject, inputs: edit.data.inputs }, kind: 'image', signal: new AbortController().signal, deadline: Date.now() + 120000 })
      const legacyCommand = { actor, modelId, prompt: normalized.prompt, parameters: normalized.parameters, normalizedInputs: normalized.inputs, intendedMode: normalized.mode, idempotencyKey: `legacy:${randomUUID()}` }
      const createdId = await envelope(await create(legacyCommand))
      assert.equal((await pool.query('SELECT normalized_request FROM generation_jobs WHERE id=$1', [createdId])).rows[0].normalized_request.mode, 'inpaint')
      assert.equal((await pool.query('SELECT count(*) FROM outbox_events WHERE aggregate_id=$1', [createdId])).rows[0].count, '1')
      const { intendedMode: _, ...manual } = legacyCommand
      const response = await create(manual)
      assert.equal(response.status, 409, 'absent internal intent still derives legacy image_to_image and conflicts with frozen inpaint')
      assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT')
    })
    const publicEdit = async (key: string, selection: { x: number; y: number; width: number; height: number }, ports: ImageEditPorts = editPorts) => {
      const form = new FormData()
      form.append('modelId', modelId)
      form.append('prompt', 'Public region edit')
      form.append('assetId', assetId)
      form.append('region', JSON.stringify(selection))
      const context = {
        actor,
        request: { formData: async () => form, headers: new Headers({ 'idempotency-key': key }) },
      } as unknown as AuthedContext
      return editImage(context, ports)
    }
    const countFor = async (key: string) => ({
      jobs: (await pool.query('SELECT count(*) FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actorId, key])).rows[0].count,
      outbox: (await pool.query('SELECT count(*) FROM outbox_events WHERE dedupe_key=$1', [`gen:${actorId}:${key}`])).rows[0].count,
    })
    await t.test('public multipart retries replay one job and one outbox through the shared command', async () => {
      const region = { x: 10, y: 10, width: 64, height: 64 }
      const key = `public:${randomUUID()}`
      const first = await publicEdit(key, region)
      const firstBody = await first.json()
      assert.equal(first.status, 202, JSON.stringify(firstBody))
      const jobId = firstBody.data.id as string
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
      // Sequential retry: same job, no second artifact staged for the key.
      const second = await publicEdit(key, region)
      const secondBody = await second.json()
      assert.equal(second.status, 202, JSON.stringify(secondBody))
      assert.equal(secondBody.data.id, jobId)
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
      // Concurrent retry on a fresh key: deterministic staging plus the
      // full-payload winner comparison still leaves exactly one job/outbox.
      const concurrentKey = `public-concurrent:${randomUUID()}`
      const [left, right] = await Promise.all([publicEdit(concurrentKey, region), publicEdit(concurrentKey, region)])
      const [leftBody, rightBody] = [await left.json(), await right.json()]
      assert.equal(left.status, 202, JSON.stringify(leftBody))
      assert.equal(right.status, 202, JSON.stringify(rightBody))
      assert.equal(leftBody.data.id, rightBody.data.id)
      assert.deepEqual(await countFor(concurrentKey), { jobs: '1', outbox: '1' })
      // Changed content under the same key conflicts and leaves the stored job alone.
      const conflict = await publicEdit(key, { x: 120, y: 120, width: 64, height: 64 })
      const conflictBody = await conflict.json()
      assert.equal(conflict.status, 409, JSON.stringify(conflictBody))
      assert.equal(conflictBody.error?.code, 'IDEMPOTENCY_CONFLICT')
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
    })
    await t.test('pre-keyed legacy job replays only after byte-identity verification', async () => {
      const region = { x: 20, y: 20, width: 48, height: 48 }
      const key = `legacy-public:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const legacyMaskId = randomUUID()
      const legacyObjectKey = `synthetic/${actorId}/legacy-${legacyMaskId}.png`
      await pool.query("INSERT INTO generation_input_images(id,created_by,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [legacyMaskId, actorId, legacyObjectKey, maskBytes.length, digest(maskBytes)])
      await pool.query("INSERT INTO media_uploads(id,created_by,media_kind,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'image','ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [legacyMaskId, actorId, legacyObjectKey, maskBytes.length, digest(maskBytes)])
      // A pre-fix job carried a random mask id; the retry must map onto it by bytes.
      const legacy = await prepareImageEdit({ actor, modelId, prompt: 'Legacy public edit', assetId, selection: region, ports: editPorts, dryRun: true })
      assert.equal(legacy.success, true); if (!legacy.success) throw new Error('legacy prepare')
      const legacyJobId = await envelope(await create({ actor, modelId, prompt: legacy.data.prompt, parameters: legacy.data.parameters, normalizedInputs: [{ assetId, role: 'reference_image', position: 0 }, { uploadId: legacyMaskId, role: 'mask', position: 1 }], idempotencyKey: key }))
      const legacyContext = {
        actor,
        request: {
          formData: async () => { const form = new FormData(); form.append('modelId', modelId); form.append('prompt', 'Legacy public edit'); form.append('assetId', assetId); form.append('region', JSON.stringify(region)); return form },
          headers: new Headers({ 'idempotency-key': key }),
        },
      } as unknown as AuthedContext
      const replay = await editImage(legacyContext, editPorts)
      const replayBody = await replay.json()
      assert.equal(replay.status, 202, JSON.stringify(replayBody))
      assert.equal(replayBody.data.id, legacyJobId, 'the frozen legacy job replays')
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
      // Changed bytes under the same key stay a conflict.
      const conflict = await publicEdit(key, { x: 60, y: 60, width: 48, height: 48 })
      const conflictBody = await conflict.json()
      assert.equal(conflict.status, 409, JSON.stringify(conflictBody))
      assert.equal(conflictBody.error?.code, 'IDEMPOTENCY_CONFLICT')
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
    })
    await t.test('a failed keyed retry preserves the winner object and job', async () => {
      const region = { x: 10, y: 10, width: 64, height: 64 }
      const key = `public-loser:${randomUUID()}`
      const winner = await publicEdit(key, region)
      const winnerBody = await winner.json()
      assert.equal(winner.status, 202, JSON.stringify(winnerBody))
      const attachedKey = (await pool.query('SELECT object_key FROM generation_input_images WHERE attached_job_id=$1 LIMIT 1', [winnerBody.data.id])).rows[0].object_key as string
      assert.ok(objects.has(attachedKey), 'the winner object is staged')
      // Force the loser to pre-check before the winner committed, then fail after
      // its own object write: it must not compensating-delete the winner object.
      let hidJob = false
      let transactions = 0
      const racingPorts: ImageEditPorts = {
        ...editPorts,
        db: () => ({
          query: async (sql, params = []) => {
            if (sql.includes('FROM generation_jobs') && !hidJob) { hidJob = true; return { rows: [] } }
            return editPorts.db().query(sql, params)
          },
        }),
        runTransaction: async fn => {
          transactions += 1
          if (transactions === 2) throw new Error('INJECTED_ROW_FAILURE')
          return editPorts.runTransaction(fn)
        },
      }
      const loser = await publicEdit(key, region, racingPorts)
      const loserBody = await loser.json()
      assert.equal(loser.status, 503, JSON.stringify(loserBody))
      assert.ok(objects.has(attachedKey), 'a loser failure must not delete the winner object')
      assert.deepEqual(await countFor(key), { jobs: '1', outbox: '1' })
    })
    await t.test('a reclaimed keyed row refuses to rebuild its object', async () => {
      const region = { x: 50, y: 50, width: 48, height: 48 }
      const key = `public-reclaimed:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const maskId = createStableUploadIds(`${actorId}:${key}`).derive('mask', digest(maskBytes))
      const objectKey = `inputs/${actorId}/${maskId}.png`
      await pool.query("INSERT INTO generation_input_images(id,created_by,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at,deleted_at,object_deleted_at) VALUES($1,$2,'deleted',$3,'image/png',1200,800,$4,$5,now()-interval '1 hour',now()-interval '1 hour',now())", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      await pool.query("INSERT INTO media_uploads(id,created_by,media_kind,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at,deleted_at,object_deleted_at) VALUES($1,$2,'image','deleted',$3,'image/png',1200,800,$4,$5,now()-interval '1 hour',now()-interval '1 hour',now())", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      const response = await publicEdit(key, region)
      const body = await response.json()
      assert.equal(response.status, 409, JSON.stringify(body))
      assert.equal(body.error?.code, 'IDEMPOTENCY_CONFLICT')
      assert.ok(!objects.has(objectKey), 'no object is rebuilt under a reclaimed row')
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
    await t.test('a late keyed PUT is removed when its row was reclaimed mid-flight', async () => {
      const region = { x: 25, y: 25, width: 48, height: 48 }
      const key = `late-put:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const maskId = createStableUploadIds(`${actorId}:${key}`).derive('mask', digest(maskBytes))
      const objectKey = `inputs/${actorId}/${maskId}.png`
      await pool.query("INSERT INTO generation_input_images(id,created_by,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      await pool.query("INSERT INTO media_uploads(id,created_by,media_kind,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'image','ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      let transactions = 0
      const latePorts: ImageEditPorts = {
        ...editPorts,
        runTransaction: async fn => {
          transactions += 1
          const result = await editPorts.runTransaction(fn)
          // Simulate the TTL sweep reclaiming the claimed row before promote.
          if (transactions === 1) {
            await pool.query("UPDATE generation_input_images SET status='deleted',deleted_at=now(),object_deleted_at=now() WHERE id=$1", [maskId])
            await pool.query("UPDATE media_uploads SET status='deleted',deleted_at=now(),object_deleted_at=now() WHERE id=$1", [maskId])
          }
          return result
        },
      }
      const response = await publicEdit(key, region, latePorts)
      const body = await response.json()
      assert.equal(response.status, 409, JSON.stringify(body))
      assert.equal(body.error?.code, 'IDEMPOTENCY_CONFLICT')
      assert.ok(!objects.has(objectKey), 'the late object is reclaimed even though its row was tombstoned')
      assert.deepEqual(await countFor(key), { jobs: '0', outbox: '0' })
      // The success marker must actually land on both tables (a JS date round-trip
      // or an aborted marker transaction would leave one of them NULL here).
      const legacyMarker = (await pool.query('SELECT object_deleted_at FROM generation_input_images WHERE id=$1', [maskId])).rows[0]
      const mirrorMarker = (await pool.query('SELECT object_deleted_at FROM media_uploads WHERE id=$1', [maskId])).rows[0]
      assert.ok(legacyMarker.object_deleted_at, 'the success marker is applied to the legacy row')
      assert.ok(mirrorMarker.object_deleted_at, 'the success marker is applied to the mirror row')
    })
    await t.test('a late keyed object is kept when attach binds it first', async () => {
      const region = { x: 35, y: 35, width: 48, height: 48 }
      const key = `late-attach:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const maskId = createStableUploadIds(`${actorId}:${key}`).derive('mask', digest(maskBytes))
      const objectKey = `inputs/${actorId}/${maskId}.png`
      await pool.query("INSERT INTO generation_input_images(id,created_by,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      await pool.query("INSERT INTO media_uploads(id,created_by,media_kind,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'image','ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      objects.set(objectKey, maskBytes)
      const raceJobId = await envelope(await create({ actor, modelId, prompt: 'Race holder', parameters: { count: 1, size: '1536x1024' }, normalizedInputs: [], idempotencyKey: `race-holder:${randomUUID()}` }))
      let transactions = 0
      const latePorts: ImageEditPorts = {
        ...editPorts,
        runTransaction: async fn => {
          transactions += 1
          const result = await editPorts.runTransaction(fn)
          if (transactions === 1) {
            // The sweep tombstones the legacy row only; the media mirror stays usable.
            await pool.query("UPDATE generation_input_images SET status='deleted',deleted_at=now(),object_deleted_at=now() WHERE id=$1", [maskId])
            // Attach wins the row locks and binds the reference before discard runs.
            await tx(async client => {
              await client.query('SELECT id FROM media_uploads WHERE id=$1 FOR UPDATE', [maskId])
              await client.query('SELECT id FROM generation_input_images WHERE id=$1 FOR UPDATE', [maskId])
              await client.query("INSERT INTO generation_job_inputs(job_id,input_image_id,upload_id,position,role) VALUES($1,$2,$3,0,'reference_image')", [raceJobId, maskId, maskId])
              await client.query("UPDATE media_uploads SET status='attached',attached_job_id=$2,updated_at=now() WHERE id=$1", [maskId, raceJobId])
            })
          }
          return result
        },
      }
      const response = await publicEdit(key, region, latePorts)
      const body = await response.json()
      assert.equal(response.status, 409, JSON.stringify(body))
      assert.ok(objects.has(objectKey), 'a bound object survives the discard path')
      assert.equal((await pool.query('SELECT count(*) FROM generation_job_inputs WHERE job_id=$1', [raceJobId])).rows[0].count, '1')
    })
    await t.test('a stale success marker cannot clobber a newer retirement', async () => {
      const region = { x: 45, y: 45, width: 48, height: 48 }
      const key = `late-marker:${randomUUID()}`
      const maskBytes = await createEditMask({ imageWidth: 1200, imageHeight: 800, selection: region })
      const maskId = createStableUploadIds(`${actorId}:${key}`).derive('mask', digest(maskBytes))
      const objectKey = `inputs/${actorId}/${maskId}.png`
      await pool.query("INSERT INTO generation_input_images(id,created_by,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      await pool.query("INSERT INTO media_uploads(id,created_by,media_kind,status,object_key,mime_type,width,height,size_bytes,checksum,expires_at) VALUES($1,$2,'image','ready',$3,'image/png',1200,800,$4,$5,now()+interval '1 hour')", [maskId, actorId, objectKey, maskBytes.length, digest(maskBytes)])
      let transactions = 0
      let deleteCalls = 0
      const markerPorts: ImageEditPorts = {
        ...editPorts,
        runTransaction: async fn => {
          transactions += 1
          const result = await editPorts.runTransaction(fn)
          if (transactions === 1) {
            await pool.query("UPDATE generation_input_images SET status='deleted',deleted_at=now(),object_deleted_at=now() WHERE id=$1", [maskId])
          }
          return result
        },
        deleteObject: async objKey => {
          deleteCalls += 1
          await editPorts.deleteObject(objKey)
          // A newer retirement re-registers a fresh object and a new fence
          // before the older success marker gets to run.
          objects.set(objKey, maskBytes)
          await pool.query("UPDATE generation_input_images SET status='deleted', deleted_at=now(), object_deleted_at=NULL, updated_at=now() WHERE id=$1", [maskId])
          await pool.query("UPDATE media_uploads SET status='deleted', deleted_at=now(), object_deleted_at=NULL, updated_at=now() WHERE id=$1", [maskId])
        },
      }
      const response = await publicEdit(key, region, markerPorts)
      const body = await response.json()
      assert.equal(response.status, 409, JSON.stringify(body))
      assert.equal(deleteCalls, 1)
      assert.ok(objects.has(objectKey), 'the newer object is still present')
      const rows = await pool.query('SELECT status, object_deleted_at FROM generation_input_images WHERE id=$1', [maskId])
      assert.equal(rows.rows[0].status, 'deleted')
      assert.equal(rows.rows[0].object_deleted_at, null, 'the stale marker did not hide the newer retry state')
      const mirrorRows = await pool.query('SELECT status, object_deleted_at FROM media_uploads WHERE id=$1', [maskId])
      assert.equal(mirrorRows.rows[0].status, 'deleted')
      assert.equal(mirrorRows.rows[0].object_deleted_at, null, 'the stale marker did not hide the newer mirror retry state')
    })

  } finally {
    // Every delete is bounded by a brand-new actor/scope. No baseline rows touched.
    try { await tx(async client => {
      if (scope) {
        await client.query('DELETE FROM canvas_agent_pending_jobs WHERE session_id=$1 AND created_by=$2', [scope.sessionId, actorId])
        await client.query('DELETE FROM canvas_agent_messages WHERE session_id=$1', [scope.sessionId])
        await client.query('UPDATE canvas_agent_sessions SET running_turn_id=NULL,running_lease_token=NULL,running_lease_expires_at=NULL WHERE id=$1', [scope.sessionId])
        await client.query('DELETE FROM canvas_agent_turns WHERE session_id=$1', [scope.sessionId])
        await client.query('DELETE FROM canvas_agent_sessions WHERE id=$1', [scope.sessionId])
        await client.query('DELETE FROM canvas_documents WHERE id=$1 AND created_by=$2', [scope.canvasId, actorId])
        assert.equal((await client.query('SELECT count(*) FROM canvas_agent_preparations WHERE created_by=$1', [actorId])).rows[0].count, '0', 'turn/session deletion cascades owned preparations')
      }
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
