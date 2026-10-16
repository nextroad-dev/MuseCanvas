import { NextRequest } from 'next/server'
import { createCanvasAgentHandlers } from './handlers'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { parseCanvasAgentMessageRequest } from '@musecanvas/contracts'
import { PgAgentStore } from './store'
import { publicMessage, publicPending, publicTurn } from './history'
import { canvasAgentPendingIdentity } from '@musecanvas/database'

const actorId = randomUUID(), canvasId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), messageId = randomUUID()
const raw = (object: object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), value]))
const snapshot = { kind: 'user', messageId, text: 'edit', baseRevision: 4, requireConfirmation: true, sceneCommitMode: 'agent-managed', context: { modelId: randomUUID(), inputs: [{ assetId: randomUUID(), role: 'reference_image', position: 0 }], editSource: { assetId: randomUUID(), selection: { x: 1, y: 2, width: 3, height: 4 } } } }
const ids = canvasAgentPendingIdentity(canvasId, `${turnId}:edit`)
const pending: any = { ...ids, sessionId, turnId, canvasId, createdBy: actorId, toolCallId: `${turnId}:edit`, kind: 'image', modelId: snapshot.context.modelId, prompt: 'edit', parameters: {}, sourceNodeId: null, sourceAssetId: snapshot.context.editSource.assetId, baseRevision: 4, requestVersion: 2, normalizedRequest: { mode: 'inpaint' }, editMetadata: { selection: { x: 1, y: 2, width: 3, height: 4 }, sourceWidth: 10, sourceHeight: 12 }, normalizedInputs: snapshot.context.inputs, status: 'pending', jobId: null, leaseToken: 'private-lease', modelConfigDigest: 'private-digest' }
const turn: any = { id: turnId, sessionId, messageId, status: 'canceled', requestSnapshot: snapshot, sceneCommitRevision: 5, sceneCommitAt: '2026-10-06T00:00:00Z', leaseToken: 'private-lease' }

// Explicit query doubles, NOT PostgreSQL/migration/locking evidence.
function fixture(owner = actorId, savedTurn = turn) {
  const calls: string[] = []
  const tx: any = async (fn: any) => fn({ query: async (sql: string, values: unknown[]) => {
    calls.push(sql)
    assert.ok(sql.startsWith('SELECT'), 'recovery/existingPending must be read-only')
    assert.ok(sql.includes('deleted_at IS NULL'))
    if (sql.startsWith('SELECT revision,scene')) return { rows: values[1] === owner ? [{ revision: 5, scene: { nodes: [], edges: [] } }] : [] }
    assert.deepEqual(values.slice(0, 2), [actorId, canvasId])
    assert.ok(sql.includes('c.created_by = $1'))
    if (values[0] !== owner) return { rows: [] }
    if (sql.startsWith('SELECT s.*')) return { rows: [raw({ id: sessionId, canvasId, createdBy: owner })] }
    if (sql.startsWith('SELECT t.*')) return { rows: values[3] === savedTurn.id ? [raw(savedTurn)] : [] }
    if (sql.startsWith('SELECT p.*')) return { rows: values[3] === pending.id || values[3] === turnId ? [raw(pending)] : [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  } })
  return { store: new PgAgentStore(tx), calls }
}
test('owner-only recovery reads original validated snapshot, status/commit and safe owned turn pending without runtime config', async () => {
  const f = fixture()
  const dto = await f.store.turn(actorId, canvasId, turnId)
  assert.deepEqual(dto.requestSnapshot, parseCanvasAgentMessageRequest(snapshot).success ? snapshot : null)
  assert.equal(dto.status, 'canceled'); assert.equal(dto.sceneCommitRevision, 5); assert.equal(dto.legacySnapshotUnavailable, false)
  assert.equal(dto.pendingJobs.length, 1)
  assert.equal(dto.pendingJobs[0]!.mode, 'inpaint')
  assert.deepEqual(dto.pendingJobs[0]!.editMetadata, pending.editMetadata)
  assert.ok(!JSON.stringify(dto).includes('private-'))
  await assert.rejects(fixture(randomUUID()).store.turn(actorId, canvasId, turnId))
  await assert.rejects(f.store.turn(actorId, canvasId, randomUUID()))
  assert.ok(f.calls.every(sql => !sql.includes('provider_credentials') && !sql.includes('model_configs')))
})
test('legacy and corrupted snapshots are unavailable, never reconstructed or leaked', () => {
  for (const requestSnapshot of [null, { ...snapshot, credential: 'private-key' }, { ...snapshot, messageId: randomUUID() }]) {
    const dto = publicTurn({ ...turn, requestSnapshot }, [pending])
    assert.equal(dto.requestSnapshot, null); assert.equal(dto.legacySnapshotUnavailable, true)
    assert.ok(!JSON.stringify(dto).includes('private-'))
  }
})
test('safe history context summary preserves validated opaque inputs/selection, hides raw provider content blocks', () => {
  const message: any = { id: messageId, role: 'user', content: 'edit', contentBlocks: [{ type: 'canvas_agent_context', context: snapshot.context }, { private: 'private-block' }] }
  assert.deepEqual(publicMessage(message).contextSummary, snapshot.context)
  assert.ok(!JSON.stringify(publicMessage(message)).includes('private-'))
  message.contentBlocks = [{ type: 'canvas_agent_context', context: { ...snapshot.context, providerUrl: 'private-url' } }]
  assert.equal(publicMessage(message).contextSummary, undefined)
  message.role = 'assistant'; assert.equal(publicMessage(message).contextSummary, undefined)
})
test('existingPending deterministic lookup is owner/turn scoped and read-only, does not prepare or attach', async () => {
  const f = fixture(), ctx: any = { scope: { actorId, canvasId, sessionId }, lease: { turnId } }
  assert.equal((await f.store.existingPending(ctx, `${turnId}:edit`))!.id, pending.id)
  assert.equal(await f.store.existingPending({ ...ctx, lease: { turnId: randomUUID() } }, `${turnId}:edit`), null)
  assert.equal(await f.store.existingPending(ctx, `${turnId}:missing`), null)
})
test('public pending reports actual mode and clamped rectangle but ignores invalid metadata', () => {
  assert.equal(publicPending(pending).mode, 'inpaint')
  assert.equal(publicPending({ ...pending, editMetadata: { ...pending.editMetadata, sourceWidth: 1 } }).editMetadata, undefined)
  assert.equal(publicPending({ ...pending, requestVersion: 1 }).mode, 'text_to_image')
})

test('recovery HTTP handler validates turn ID, actor/owner and rate limit; no stream/model/generation call (query fake)', async () => {
  const f = fixture()
  const handlers = createCanvasAgentHandlers({ store: f.store, limited: async () => false,
    chat: async () => assert.fail('recovery is read-only'), create: async () => assert.fail('recovery never creates') })
  const context: any = { actor: { id: actorId, status: 'active' }, params: { id: canvasId, turnId }, request: new NextRequest(`https://example.test/api/canvases/${canvasId}/agent/turns/${turnId}`) }
  const response = await handlers.turn(context)
  assert.equal(response.status, 200); const body = await response.json()
  assert.equal(body.data.turnId, turnId); assert.equal(body.data.pendingJobs[0].mode, 'inpaint'); assert.ok(!JSON.stringify(body).includes('private-'))
  assert.equal((await handlers.turn({ ...context, params: { id: canvasId, turnId: 'invalid' } })).status, 400)
  assert.equal((await handlers.turn({ ...context, actor: { id: actorId, status: 'suspended' } })).status, 403)
  assert.equal((await handlers.turn({ ...context, actor: { id: randomUUID(), status: 'active' } })).status, 404)
  assert.equal((await handlers.turn({ ...context, params: { id: canvasId, turnId: randomUUID() } })).status, 404)
  let key = ''
  const limited = createCanvasAgentHandlers({ store: f.store, chat: async () => assert.fail(), create: async () => assert.fail(), limited: async value => { key = value; return true } })
  assert.equal((await limited.turn(context)).status, 429); assert.equal(key, `canvas-agent:${actorId}`)
})
