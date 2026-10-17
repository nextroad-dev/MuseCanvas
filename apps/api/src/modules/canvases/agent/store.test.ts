import { NextRequest } from 'next/server'
import { createCanvasAgentHandlers } from './handlers'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type pg from 'pg'
import { CANVAS_AGENT_SETTINGS_DEFAULTS, CanvasErrorCode as C, type ModelCapabilities, type JsonObject } from '@musecanvas/contracts'
import { canvasAgentGenerationRequest, canvasAgentRequestDigest, canvasAgentPendingIdentity, type CanvasAgentPendingJob } from '@musecanvas/database'
import { validateGenerationRequest } from '@musecanvas/domain'
import { executeTool } from './tools'
import type { GenerationCreate } from './submit'
import { encryptProviderCredential } from '@musecanvas/providers'
import { NextResponse } from 'next/server'
import { runAgent } from './loop'
import { submitPending } from './submit'
import { AgentError, modelConfigDigest } from './config'
import { PgAgentStore, type RunContext } from './store'

process.env.APP_MASTER_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const actorId = randomUUID(), canvasId = randomUUID(), sessionId = randomUUID(), modelId = randomUUID(), credentialId = randomUUID(), turnId = randomUUID(), jobId = randomUUID()
const raw = (object: object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), value]))
const caps = { modes: ['text_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', parameters: [{ name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 }], inputSlots: [], maxCount: 1 }
function fixture(options: { revision?: number; modelChanged?: boolean; expired?: boolean; terminalStatus?: string; noAsset?: boolean; existingJob?: boolean; video?: boolean; capabilities?: ModelCapabilities; defaults?: JsonObject } = {}) {
  const settings = { ...CANVAS_AGENT_SETTINGS_DEFAULTS, enabled: true, languageModelConfigId: modelId, updatedAt: new Date().toISOString() }
  const cipher = encryptProviderCredential('test-only-private-key')
  const credential = { id: credentialId, enabled: true, api_key_encrypted: cipher.ciphertext, encryption_key_id: cipher.keyId, schema_id: 'legacy-api-key-v1', updated_at: new Date(0) }
  const sourceAssetId = randomUUID(), sourceNodeId = randomUUID()
  const capabilities = options.capabilities ?? (options.video ? { ...caps, modes: ['image_to_video'], supportedMediaKinds: ['video'], inputSlots: [{ role: 'first_frame', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] }] } : caps)
  const model = { id: modelId, model_kind: options.video ? 'video' : 'image', enabled: true, vendor_model_id: 'image-test', provider_credential_id: credentialId, latest_revision_id: randomUUID(), capabilities, defaults: options.defaults ?? { count: 1 }, updated_at: new Date(0) }
  const language = { ...model, model_kind: 'language', language_protocol: 'openai_chat', plugin_id: 'openai-language', plugin_version: '1.0.0', max_output_tokens: 1000 }
  const ids = canvasAgentPendingIdentity(canvasId, `${turnId}:call`)
  const pending: CanvasAgentPendingJob = { ...ids, sessionId, canvasId, createdBy: actorId, turnId, toolCallId: `${turnId}:call`, kind: options.video ? 'video' : 'image', prompt: 'cat', modelId, parameters: { count: 1 }, sourceNodeId: options.video ? sourceNodeId : null, sourceAssetId: options.video ? sourceAssetId : null, baseRevision: 1,
    expiresAt: new Date(Date.now() + 600000).toISOString(), ops: [{ type: 'add_node', node: { id: ids.nodeId, type: options.video ? 'video' : 'image', position: { x: 0, y: 0 }, data: { prompt: 'cat' } } }], modelConfigDigest: modelConfigDigest(model, credential),
    requestDigest: 'a'.repeat(64), status: 'pending', jobId: null, leaseToken: null, leaseExpiresAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const job = { id: jobId, model_id: modelId, media_kind: pending.kind, normalized_request: canvasAgentGenerationRequest(pending) }
  if (options.modelChanged) model.latest_revision_id = randomUUID()
  const session = { id: sessionId, canvasId, createdBy: actorId, requireConfirmation: false, nextSeq: 1, autoContinuationCount: 0 }
  const sql: string[] = [], args: unknown[][] = []; let committed = false
  const client = { query: async (query: string, values: unknown[] = []) => {
    const text = query.replace(/\s+/g, ' ').trim(); sql.push(text); args.push(values)
    if (text.startsWith('SELECT revision, scene, cover_asset_id')) { assert.deepEqual(values, [actorId, canvasId]); return { rows: [{ revision: options.revision ?? 1, scene: { nodes: [], edges: [] }, cover_asset_id: null }] } }
    if (text.startsWith('SELECT revision,scene')) { assert.deepEqual(values, [canvasId, actorId]); return { rows: [{ revision: options.revision ?? 1, scene: { nodes: options.video ? [{ id: sourceNodeId, type: 'image', position: { x: 0, y: 0 }, data: { assetId: sourceAssetId } }] : [], edges: [] } }] } }
    if (text.startsWith('INSERT INTO canvas_agent_sessions')) return { rows: [] }
    if (text.startsWith('SELECT s.*')) { assert.ok(text.includes('c.created_by = $1')); return { rows: [raw(session)] } }
    if (text.startsWith('SELECT p.*')) { assert.ok(text.includes('s.canvas_id = p.canvas_id AND s.created_by = p.created_by')); return { rows: [raw(pending)] } }
    if (text.startsWith('SELECT * FROM canvas_agent_settings')) return { rows: [raw(settings)] }
    if (text.startsWith('SELECT * FROM model_configs')) return { rows: [language] }
    if (text.startsWith('SELECT * FROM provider_credentials')) return { rows: [credential] }
    if (text.startsWith('SELECT m.*')) return { rows: [model] }
    if (text.startsWith('SELECT t.*')) return { rows: text.includes('FOR UPDATE OF t') ? [raw({ id: turnId, sessionId, messageId: randomUUID(), status: 'completed' })] : [] }
    if (text.startsWith('SELECT id,status,error_code FROM generation_jobs')) { assert.deepEqual(values, [jobId, actorId]); return { rows: [{ id: jobId, status: options.terminalStatus ?? 'running', error_code: 'unsafe error string' }] } }
    if (text.startsWith('SELECT id FROM assets')) { assert.deepEqual(values, [sourceAssetId, actorId]); return { rows: [{ id: sourceAssetId }] } }
    if (text.startsWith('SELECT id,media_kind FROM assets')) { assert.deepEqual(values, [jobId, actorId]); return { rows: options.noAsset ? [] : [{ id: randomUUID(), media_kind: 'image' }] } }
    if (text.startsWith('SELECT id,media_kind,model_id,normalized_request FROM generation_jobs')) { assert.deepEqual(values, [actorId, pending.idempotencyKey]); return { rows: options.existingJob ? [job] : [] } }
    if (text.startsWith('SELECT j.*')) { assert.ok(text.includes('j.idempotency_key = p.idempotency_key')); return { rows: [job] } }
    if (text.startsWith('UPDATE canvas_agent_pending_jobs SET')) { assert.ok(text.includes("status='pending'")); pending.status = 'expired'; return { rows: [] } }
    if (text.startsWith('UPDATE canvas_agent_pending_jobs p SET status = \'expired\'')) { assert.ok(text.includes('p.expires_at <= now()')); if (options.expired) pending.status = 'expired'; return { rows: [] } }
    if (text.startsWith('UPDATE canvas_agent_pending_jobs p SET status = \'submitting\'')) { assert.ok(text.includes('p.lease_expires_at <= now()')); if (options.expired) return { rows: [] }; pending.status = 'submitting'; pending.leaseToken = values[4] as string; return { rows: [raw(pending)] } }
    if (text.startsWith('UPDATE canvas_agent_pending_jobs p SET status = \'submitted\'')) { assert.ok(text.includes('j.created_by = $1 AND j.idempotency_key = p.idempotency_key')); assert.ok(text.includes('j.media_kind = p.kind AND j.model_id = p.model_id AND j.normalized_request = $8::jsonb')); assert.deepEqual(JSON.parse(values[7] as string), canvasAgentGenerationRequest(pending)); pending.status = 'submitted'; pending.jobId = jobId; pending.ops = JSON.parse(values[6] as string); return { rows: [raw(pending)] } }
    throw new Error(`Unexpected SQL: ${text}`)
  } } as unknown as pg.PoolClient
  const tx: any = async (fn: any) => { const result = await fn(client); committed = true; return result }
  return { store: new PgAgentStore(tx), pending, job, language, credential, settings, session, client, sql, args, committed: () => committed }
}
 test('production confirm revision change expires pending in committed tx then returns conflict', async () => {
  const f = fixture({ revision: 2 })
  await assert.rejects(f.store.claim(actorId, canvasId, { pendingId: f.pending.id, approve: true }, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_CONFIRM_CONFLICT)
  assert.equal(f.pending.status, 'expired'); assert.equal(f.committed(), true); assert.ok(!f.sql.some(sql => sql.includes("SET status = 'submitting'")))
})
 test('production frozen config fingerprint mismatch blocks claim', async () => {
  const f = fixture({ modelChanged: true })
  await assert.rejects(f.store.claim(actorId, canvasId, { pendingId: f.pending.id, approve: true }, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_CONFIRM_CONFLICT)
  assert.equal(f.pending.status, 'pending'); assert.ok(!f.sql.some(sql => sql.includes("SET status = 'submitting'")))
})
 test('production expired confirm delegates DB clock expiry to CAS and never claims', async () => {
  const f = fixture({ expired: true })
  await assert.rejects(f.store.claim(actorId, canvasId, { pendingId: f.pending.id, approve: true }, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_CONFIRM_EXPIRED)
  assert.equal(f.committed(), true); assert.equal(f.pending.status, 'expired')
})
 test('production job event checks real DB terminal status and active owned linked asset before any claim', async () => {
  for (const options of [{ terminalStatus: 'running' }, { terminalStatus: 'succeeded', noAsset: true }]) {
    const f = fixture(options)
    f.pending.status = 'submitted'; f.pending.jobId = jobId
    await assert.rejects(f.store.start(actorId, canvasId, { kind: 'job_event', messageId: randomUUID(), jobId, baseRevision: 1 }), AgentError)
    assert.ok(!f.sql.some(sql => sql.startsWith('UPDATE canvas_agent_sessions') || sql.startsWith('INSERT INTO canvas_agent_turns')))
  }
})
 test('production crash recovery attaches existing owned genkey job without new task or swapping config/source', async () => {
  const f = fixture({ existingJob: true, revision: 2, modelChanged: true }); f.pending.status = 'submitting'; f.pending.leaseToken = randomUUID(); f.pending.leaseExpiresAt = new Date(0).toISOString()
  const result = await f.store.claim(actorId, canvasId, { pendingId: f.pending.id, approve: true }, 1000)
  assert.equal(result.claimed, false); assert.equal(result.pending.status, 'submitted'); assert.equal(result.pending.jobId, jobId)
  assert.equal(f.sql.some(sql => sql.startsWith('SELECT m.*')), false); assert.equal(result.pending.idempotencyKey, f.pending.idempotencyKey)
})
 test('production CanvasOp asset/job lookups are owner-scoped and require matching kind', async () => {
  const queries: { sql: string; values: unknown[] }[] = []
  const tx: any = async (fn: any) => fn({ query: async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return { rows: [] } } })
  const store = new PgAgentStore(tx), nodeId = randomUUID(), assetId = randomUUID()
  await assert.rejects(store.validateReferences({ scope: { actorId, canvasId, sessionId } } as RunContext, [{ type: 'add_node', node: { id: nodeId, type: 'image', position: { x: 0, y: 0 }, data: { assetId } } }], { nodes: [], edges: [] }), AgentError)
  assert.ok(queries[0]!.sql.includes('created_by=$2 AND deleted_at IS NULL')); assert.deepEqual(queries[0]!.values, [assetId, actorId])
})

 test('same predictable generation key cannot attach a different immutable payload in confirm or crash recovery', async () => {
  const mutate = [
    (job: any) => { job.model_id = randomUUID() },
    (job: any) => { job.normalized_request.modelId = randomUUID() },
    (job: any) => { job.normalized_request.prompt = 'different prompt' },
    (job: any) => { job.normalized_request.parameters = { count: 2 } },
    (job: any) => { job.normalized_request.inputs = [{ assetId: randomUUID(), role: 'first_frame', position: 0 }] },
    (job: any) => { job.normalized_request.inputs = [{ assetId: randomUUID(), role: 'last_frame', position: 1 }] },
    (job: any) => { job.normalized_request.mode = job.normalized_request.mode === 'image_to_video' ? 'text_to_image' : 'image_to_video' },
    (job: any) => { job.media_kind = job.media_kind === 'video' ? 'image' : 'video' },
  ]
  for (const video of [false, true]) for (const recovery of [false, true]) for (const change of mutate) {
    const f = fixture({ existingJob: true, video }); change(f.job)
    if (recovery) { f.pending.status = 'submitting'; f.pending.leaseToken = randomUUID(); f.pending.leaseExpiresAt = new Date(0).toISOString() }
    await assert.rejects(f.store.claim(actorId, canvasId, { pendingId: f.pending.id, approve: true }, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_CONFIRM_CONFLICT)
    assert.equal(f.pending.jobId, null); assert.equal(f.sql.some(sql => sql.includes("SET status = 'submitted'") || sql.includes("SET status = 'submitting'")), false)
  }
 })
 test('regular confirm validates the actual returned job payload; same normalized payload accepts and bound replay is stable', async () => {
  const actor = { id: actorId, role: 'user' as const, email: 'user@example.test', status: 'active' as const, createdAt: new Date().toISOString() }
  for (const video of [false, true]) for (const field of ['model', 'prompt', 'parameters', 'source', 'kind']) {
    const f = fixture({ video })
    if (field === 'model') f.job.model_id = randomUUID()
    if (field === 'prompt') f.job.normalized_request.prompt = 'different'
    if (field === 'parameters') f.job.normalized_request.parameters = { count: 2 }
    if (field === 'source') f.job.normalized_request.inputs = [{ assetId: randomUUID(), role: 'first_frame', position: 0 }]
    if (field === 'kind') f.job.media_kind = video ? 'image' : 'video'
    let creates = 0
    await assert.rejects(submitPending(f.store, actor, canvasId, { pendingId: f.pending.id, approve: true }, async () => { creates++; return NextResponse.json({ success: true, data: { id: jobId } }, { status: 202 }) }, new AbortController().signal, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_CONFIRM_CONFLICT)
    assert.equal(creates, 1); assert.equal(f.pending.jobId, null)
  }
  const f = fixture()
  const submitted = await submitPending(f.store, actor, canvasId, { pendingId: f.pending.id, approve: true }, async () => NextResponse.json({ success: true, data: { id: jobId } }, { status: 202 }), new AbortController().signal, 1000)
  const replay = await f.store.claim(actorId, canvasId, { pendingId: submitted.id, approve: true }, 1000)
  assert.equal(replay.claimed, false); assert.equal(replay.pending.jobId, jobId); assert.deepEqual(replay.pending.ops, submitted.ops)
 })
 test('result locks scoped session before message and freshly rejects takeover/expired lease', async () => {
  for (const state of ['valid', 'takeover', 'expired', 'missing']) {
    const statements: string[] = []; let lockHeld = false
    const lease = { turnId, leaseToken: randomUUID() }
    const tx: any = async (fn: any) => fn({ query: async (sql: string, values: unknown[]) => {
      const query = sql.replace(/\s+/g, ' ').trim(); statements.push(query)
      assert.deepEqual(values.slice(0, 3), [actorId, canvasId, sessionId])
      assert.ok(query.includes('deleted_at IS NULL')); assert.ok(query.includes('c.created_by=$1'))
      if (query.includes('FOR UPDATE OF s')) { assert.equal(statements.length, 1); lockHeld = true; return { rows: state === 'missing' ? [] : [{ id: sessionId }] } }
      assert.equal(lockHeld, true)
      if (query.startsWith('SELECT')) { assert.deepEqual(values.slice(3), [lease.turnId, lease.leaseToken]); assert.ok(query.includes('s.running_turn_id=$4 AND s.running_lease_token=$5 AND s.running_lease_expires_at>clock_timestamp()')); return { rows: state === 'valid' ? [{ id: sessionId }] : [] } }
      assert.ok(query.startsWith('UPDATE canvas_agent_messages')); assert.equal(statements.length, 3)
      assert.ok(query.includes('s.running_lease_expires_at>now()')); assert.ok(query.includes('s.running_lease_expires_at>clock_timestamp()'))
      return { rows: [{ id: values[5] }] }
    } })
    const ctx = { scope: { actorId, canvasId, sessionId }, lease } as RunContext
    const store = new PgAgentStore(tx)
    if (state === 'valid') await store.result(ctx, randomUUID(), '{}', [])
    else await assert.rejects(store.result(ctx, randomUUID(), '{}', []), (e: AgentError) => e.code === C.CANVAS_AGENT_TIMEOUT)
    assert.equal(statements.some(sql => sql.startsWith('UPDATE')), state === 'valid')
  }
 })
 test('terminal replay explicitly loads first turn after nine stored turns, without provider-window truncation', async () => {
  const f = fixture(), messageId = randomUUID(), firstTurnId = randomUUID(), nodeId = randomUUID()
  const request = { kind: 'user' as const, messageId, text: 'original', baseRevision: 1, requireConfirmation: true }
  const turn = { id: firstTurnId, sessionId, messageId, requestDigest: canvasAgentRequestDigest(request), status: 'completed', leaseToken: randomUUID(), leaseExpiresAt: new Date().toISOString(), timeoutMs: 120000, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), errorCode: null }
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: randomUUID(), session_id: sessionId, turn_id: index === 0 ? firstTurnId : randomUUID(), seq: index + 1, role: 'assistant', content: `persisted answer ${index}`,
    tool_calls: [], content_blocks: [], ops: index === 0 ? [{ type: 'add_node', node: { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'persisted' } } }] : [], input_tokens: 37 + index, output_tokens: 12, created_at: new Date() }))
  const query = f.client.query.bind(f.client)
  f.client.query = (async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT t.*')) return { rows: [raw(turn)] }
    if (sql.includes('SELECT t.id')) assert.fail('terminal replay must not use recent-eight-turn lookup')
    if (sql.startsWith('SELECT m.*')) {
      assert.ok(sql.includes('m.turn_id = $4 AND m.seq > $5')); assert.deepEqual(values.slice(0, 4), [actorId, canvasId, sessionId, firstTurnId])
      return { rows: rows.filter(row => row.turn_id === values[3] && row.seq > Number(values[4])).slice(0, Number(values[5])) }
    }
    return query(sql, values)
  }) as any
  const ctx = await f.store.start(actorId, canvasId, request)
  assert.equal(ctx.replay, true); assert.equal(ctx.messages.length, 1)
  const events: any[] = []
  await runAgent({ ctx, actor: { id: actorId } as any, store: f.store, signal: new AbortController().signal, chat: async () => { assert.fail('no LLM on replay') }, create: async () => { assert.fail('no job on replay') }, send: event => events.push(event) })
  const done = events.find(event => event.type === 'done'); assert.equal(done.message.content, 'persisted answer 0'); assert.deepEqual(done.usage, { inputTokens: 37, outputTokens: 12 })
  assert.equal(events.find(event => event.type === 'canvas_ops').ops[0].node.id, nodeId)
 })

 test('dependent defaults freeze a submission-stable pending before normal approval and same-payload crash recovery', async () => {
  const capabilities: ModelCapabilities = {
    modes: ['text_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1, inputSlots: [],
    parameters: [
      { name: 'output_format', type: 'enum', options: ['jpeg', 'png'], defaultValue: 'jpeg' },
      { name: 'output_compression', type: 'integer', min: 0, max: 100, defaultValue: 100, dependsOn: { parameter: 'output_format', values: ['jpeg'] } },
    ],
  }
  for (const recovery of [false, true]) for (const compression of [100, 82]) {
    const defaults: JsonObject = compression === 100 ? {} : { output_compression: compression }
    const f = fixture({ capabilities, defaults })
    let persisted = false, creates = 0, pendingWrites = 0
    const query = f.client.query.bind(f.client)
    f.client.query = (async (sql: string, values: unknown[] = []) => {
      if (persisted && sql.startsWith('SELECT id,media_kind,model_id,normalized_request FROM generation_jobs')) {
        assert.deepEqual(values, [actorId, f.pending.idempotencyKey]); return { rows: [f.job] }
      }
      return query(sql, values)
    }) as any
    f.store.existingPending = async () => pendingWrites ? f.pending : null
    f.store.pending = async (_ctx, input) => { pendingWrites++; Object.assign(f.pending, input); return f.pending }
    const actor = { id: actorId, role: 'user' as const, email: 'user@example.test', status: 'active' as const, createdAt: new Date().toISOString() }
    const create: GenerationCreate = async command => {
      creates++
      // This fixture repeats the REAL generation service validation; it does not
      // manufacture a normalized_request from the pending-generation helper.
      const validation = validateGenerationRequest(capabilities, { modelId: command.modelId, prompt: command.prompt, parameters: command.parameters as JsonObject,
        inputs: command.normalizedInputs, idempotencyKey: command.idempotencyKey }, { defaults })
      assert.equal(validation.valid, true); if (!validation.valid) assert.fail('service validation')
      const normalized = validation.value
      assert.deepEqual(normalized.parameters, { output_format: 'jpeg', output_compression: compression })
      assert.equal(normalized.prompt, f.pending.prompt)
      assert.deepEqual(normalized.parameters, f.pending.parameters)
      f.job.normalized_request = { modelId: normalized.modelId, prompt: normalized.prompt, parameters: normalized.parameters,
        inputs: normalized.inputs, mode: normalized.mode } as typeof f.job.normalized_request
      persisted = true
      return NextResponse.json({ success: true, data: { id: jobId } }, { status: 202 })
    }
    const ctx: RunContext = { scope: { actorId, canvasId, sessionId }, lease: { turnId, leaseToken: randomUUID() }, canvas: { revision: 1, scene: { nodes: [], edges: [] } },
      settings: f.settings, requireConfirmation: true, deadline: Date.now() + 120000, baseRevision: 1, turnStatus: 'running', turnErrorCode: null,
      config: { protocol: 'openai_chat', vendorModelId: 'test', maxOutputTokens: 1000, timeoutMs: 120000 }, autoContinuationCount: 0, replay: false, messages: [], pending: [], attemptedCalls: 0 }
    const outcome = await executeTool({ store: f.store, ctx, actor, call: { id: 'call', name: 'generate_image', arguments: { modelId, prompt: '  cat  ', parameters: {} } },
      scene: ctx.canvas.scene, signal: new AbortController().signal, create })
    const pending = outcome.pending!
    assert.equal(creates, 0); assert.equal(pendingWrites, 1)
    assert.equal(pending.prompt, 'cat'); assert.deepEqual(pending.parameters, { output_format: 'jpeg', output_compression: compression })
    if (recovery) {
      const claimed = await f.store.claim(actorId, canvasId, { pendingId: pending.id, approve: true }, 1000)
      assert.equal(claimed.claimed, true)
      await create({ actor, modelId: pending.modelId, prompt: pending.prompt, parameters: pending.parameters, normalizedInputs: [], idempotencyKey: pending.idempotencyKey })
      // Generation committed, attachment did not; recover after the lease expires.
      f.pending.leaseExpiresAt = new Date(0).toISOString()
    }
    const submitted = await submitPending(f.store, actor, canvasId, { pendingId: pending.id, approve: true }, create, new AbortController().signal, 1000)
    assert.equal(submitted.status, 'submitted'); assert.equal(submitted.jobId, jobId)
    assert.equal(creates, 1); assert.deepEqual(submitted.parameters, { output_format: 'jpeg', output_compression: compression })
    const replay = await f.store.claim(actorId, canvasId, { pendingId: pending.id, approve: true }, 1000)
    assert.equal(replay.claimed, false); assert.deepEqual(replay.pending.ops, submitted.ops)
  }
 })

test('legacy null-snapshot digest replays through HTTP parser/store/SSE boundary; altered keys conflict (DB query fake)', async () => {
  const f = fixture(), messageId = randomUUID(), firstTurnId = randomUUID()
  const legacyRequest = { kind: 'user', messageId, text: 'original', baseRevision: 1, requireConfirmation: true }
  const digest = canvasAgentRequestDigest(legacyRequest)
  const turn = { id: firstTurnId, sessionId, messageId, requestDigest: digest, status: 'completed', requestSnapshot: null,
    leaseToken: randomUUID(), leaseExpiresAt: new Date().toISOString(), timeoutMs: 120000, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), errorCode: null }
  const query = f.client.query.bind(f.client)
  f.client.query = (async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT t.*')) return { rows: [raw(turn)] }
    if (sql.startsWith('SELECT m.*')) return { rows: [{ id: randomUUID(), session_id: sessionId, turn_id: firstTurnId, seq: 1, role: 'assistant', content: 'original answer', tool_calls: [], content_blocks: [], ops: [], input_tokens: 1, output_tokens: 2, created_at: new Date() }] }
    return query(sql, values)
  }) as any
  const handlers = createCanvasAgentHandlers({ store: f.store, limited: async () => false,
    chat: async () => assert.fail('replay never calls a model'), create: async () => assert.fail('replay never creates a job') })
  const context = (body: any): any => ({ actor: { id: actorId, status: 'active' }, params: { id: canvasId },
    request: new NextRequest(`https://example.test/api/canvases/${canvasId}/agent/messages`, { method: 'POST' }), json: async () => body })
  const replay = await handlers.messages(context(legacyRequest))
  assert.equal(replay.status, 200); assert.equal(replay.headers.get('content-type'), 'text/event-stream')
  assert.ok((await replay.text()).includes('original answer'))
  for (const patch of [{ text: 'altered' }, { baseRevision: 2 }, { requireConfirmation: false }, { sceneCommitMode: 'agent-managed' }, { context: {} }]) {
    const conflict = await handlers.messages(context({ ...legacyRequest, ...patch }))
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, C.CANVAS_AGENT_MESSAGE_CONFLICT)
  }
  assert.equal(turn.requestDigest, digest); assert.equal(turn.requestSnapshot, null)
})

test('start persists parsed structured context as a user block and RunContext constraint, detached from caller (query fake)', async () => {
  const f = fixture(), messageId = randomUUID(), input: any = { kind: 'user', messageId, text: 'edit', baseRevision: 1, sceneCommitMode: 'agent-managed', context: { modelId, parameters: { count: 1 }, inputs: [{ assetId: randomUUID(), role: 'reference_image', position: 0 }], editSource: { assetId: randomUUID(), selection: { x: 2, y: 3, width: 4, height: 5 } } } }
  const expected = structuredClone(input.context)
  let saved: any, claimed: any
  const query = f.client.query.bind(f.client)
  f.client.query = (async (sql: string, values: any[]) => {
    if (sql.startsWith('UPDATE canvas_agent_sessions s SET running_turn_id')) { claimed = { ...f.session, runningTurnId: values[3], runningLeaseToken: values[4], runningLeaseExpiresAt: new Date(Date.now() + 120000).toISOString() }; return { rows: [raw(claimed)] } }
    if (sql.startsWith('UPDATE canvas_agent_turns t SET status')) return { rows: [] }
    if (sql.startsWith('INSERT INTO canvas_agent_turns')) return { rows: [raw({ id: values[3], sessionId, messageId, requestDigest: values[5], status: 'running', leaseToken: claimed.runningLeaseToken, leaseExpiresAt: claimed.runningLeaseExpiresAt, requestSnapshot: JSON.parse(values[7]) })] }
    if (sql.startsWith('SELECT m.id')) return { rows: [] }
    if (sql.startsWith('WITH allocated AS')) { saved = { id: values[5], session_id: sessionId, turn_id: values[3], seq: 1, role: values[6], content: values[7], tool_calls: JSON.parse(values[8]), content_blocks: JSON.parse(values[9]), ops: [], input_tokens: null, output_tokens: null, created_at: new Date() }; return { rows: [saved] } }
    if (sql.startsWith('SELECT t.id')) return { rows: [{ id: claimed.runningTurnId }] }
    if (sql.startsWith('SELECT m.*')) return { rows: [{ ...saved, sessionId, turnId: saved.turn_id, contentBlocks: saved.content_blocks, toolCalls: saved.tool_calls, createdAt: saved.created_at }] }
    return query(sql, values)
  }) as any
  const ctx = await f.store.start(actorId, canvasId, input)
  assert.deepEqual(ctx.context, expected); assert.deepEqual(saved.content_blocks, [{ type: 'canvas_agent_context', context: expected }])
  assert.deepEqual((ctx.requestSnapshot as any).context, expected)
  input.context.parameters.count = 9
  assert.equal(ctx.context!.parameters!.count, 1)
})

test('owned job_event lineage inherits ultimate immutable user constraints through second continuation; corrupt/foreign/cyclic lineage refuses (query doubles)', async () => {
  const { inheritedJobEventContext } = await import('./store')
  const scope = { actorId, canvasId, sessionId }, userTurnId = randomUUID(), eventTurnId = randomUUID(), originalJob = randomUUID(), continuedJob = randomUUID()
  const context: JsonObject = { intent: 'edit', modelId, parameters: { count: 1, quality: 'high' }, inputs: [
    { assetId: randomUUID(), role: 'reference_image', position: 0 }, { uploadId: randomUUID(), role: 'first_frame', position: 1 },
    { assetId: randomUUID(), role: 'last_frame', position: 2 }, { uploadId: randomUUID(), role: 'mask', position: 3 },
  ], editSource: { assetId: randomUUID(), nodeId: randomUUID(), selection: { x: 10, y: 20, width: 100, height: 100 } } }
  const user: JsonObject = { kind: 'user', messageId: randomUUID(), text: 'Explicit edit', baseRevision: 1, requireConfirmation: true, sceneCommitMode: 'agent-managed', context }
  const event: JsonObject = { kind: 'job_event', messageId: randomUUID(), jobId: originalJob, baseRevision: 1, sceneCommitMode: 'agent-managed' }
  const turn = (id: string, snapshot: JsonObject | null) => ({ id, sessionId, messageId: snapshot?.messageId ?? randomUUID(), requestSnapshot: snapshot, requestDigest: snapshot ? canvasAgentRequestDigest(snapshot) : 'a'.repeat(64) })
  const originals = [turn(userTurnId, user), turn(eventTurnId, event)]
  let turns = originals, foreign = false, missingJob = false
  const client = { query: async (sql: string, values: string[]) => {
    if (sql.startsWith('SELECT id FROM generation_jobs')) { assert.deepEqual(values, [values[0], actorId]); assert.match(sql, /created_by=\$2 AND deleted_at IS NULL/); return { rows: missingJob ? [] : [{ id: values[0] }] } }
    assert.deepEqual(values.slice(0, 3), [actorId, canvasId, sessionId])
    if (sql.startsWith('SELECT p.*')) return { rows: [raw({ createdBy: foreign ? randomUUID() : actorId, canvasId, sessionId, jobId: values[3], turnId: values[3] === originalJob ? userTurnId : eventTurnId })] }
    if (sql.startsWith('SELECT t.*')) return { rows: turns.filter(t => t.id === values[3]).map(raw) }
    assert.fail(sql)
  } } as unknown as pg.PoolClient
  assert.deepEqual(await inheritedJobEventContext(client, scope, originalJob), context)
  assert.deepEqual(await inheritedJobEventContext(client, scope, continuedJob), context)
  foreign = true; await assert.rejects(inheritedJobEventContext(client, scope, continuedJob), AgentError); foreign = false
  missingJob = true; await assert.rejects(inheritedJobEventContext(client, scope, continuedJob), AgentError); missingJob = false
  turns = [turn(userTurnId, null), originals[1]!]; assert.equal(await inheritedJobEventContext(client, scope, continuedJob), undefined)
  turns = [{ ...originals[0]!, requestDigest: 'b'.repeat(64) }, originals[1]!]; await assert.rejects(inheritedJobEventContext(client, scope, continuedJob), AgentError)
  turns = [originals[0]!, turn(eventTurnId, { ...event, jobId: continuedJob })]; await assert.rejects(inheritedJobEventContext(client, scope, continuedJob), AgentError)
})
