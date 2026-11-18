import assert from 'node:assert/strict'
import test from 'node:test'
import { lockManagedGenerationInputs, generationEffectBindingHash, type AgentBindingInput } from './agent-inputs'
import { prepareGeneration, createGenerationInTransaction, type PreparedGeneration } from './create-job'
import type { SqlClient } from '../ports'

const ownerId = '11111111-1111-4111-8111-111111111111'
const sourceId = '22222222-2222-4222-8222-222222222222'
const maskId = '33333333-3333-4333-8333-333333333333'
const revisionId = '44444444-4444-4444-8444-444444444444'
const bindings: AgentBindingInput[] = [{ id: sourceId, checksum: 'a'.repeat(64), role: 'reference_image', position: 0 }, { id: maskId, checksum: 'b'.repeat(64), role: 'mask', position: 1, sourceChecksum: 'a'.repeat(64), preparationVersion: 1 }]
function fixture(options: { status?: string; expired?: boolean; mirrorMissing?: boolean; checksum?: string; dimensions?: boolean; kind?: string; missingSource?: boolean; unprepared?: boolean } = {}) {
  const calls: string[] = []
  const upload = { id: maskId, status: options.status ?? 'ready', unexpired: !options.expired, attached_job_id: options.status === 'attached' ? 'job' : null,
    checksum: options.checksum ?? 'b'.repeat(64), media_kind: options.kind ?? 'image', mime_type: 'image/png', width: 1024, height: options.dimensions ? 512 : 1024, size_bytes: 100 }
  const client: SqlClient = { async query(sql) {
    calls.push(sql)
    if (sql.includes('FROM media_uploads')) return { rows: [upload] }
    if (sql.includes('FROM generation_input_images')) return { rows: options.mirrorMissing ? [] : [upload] }
    if (sql.includes('FROM assets')) return { rows: options.missingSource ? [] : [{ ...upload, id: sourceId, media_kind: 'image', height: 1024, checksum: 'a'.repeat(64) }] }
    if (sql.includes('agent_media_mask_preparations')) return { rows: options.unprepared ? [] : [{ owner_id: ownerId, source_checksum: 'a'.repeat(64), mask_checksum: 'b'.repeat(64), width: 1024, height: 1024, preparation_version: 1 }] }
    assert.fail(`unexpected SQL: ${sql}`)
  } }
  const prepared = { command: { ownerId, intendedMode: 'inpaint', normalizedInputs: [{ assetId: sourceId, role: 'reference_image', position: 0 }, { uploadId: maskId, role: 'mask', position: 1 }] },
    runtimeLimits: { maxImageBytes: 200, maxTotalBytes: 400, maxInputs: 4 },
  } as PreparedGeneration
  return { client, prepared, calls }
}

test('managed edit locks actual owned source/mask checksum, geometry and mirrored ready state in shared attach order', async () => {
  const f = fixture()
  const identities = await lockManagedGenerationInputs(f.client, f.prepared, bindings)
  assert.deepEqual(identities.map(i => [i.kind, i.role]), [['asset', 'reference_image'], ['upload', 'mask']])
  assert.match(f.calls[0], /FROM media_uploads.*created_by=\$2/s)
  assert.match(f.calls[1], /FROM generation_input_images/)
  assert.match(f.calls[2], /FROM assets.*FOR SHARE/s)
  assert.match(f.calls[3], /agent_media_mask_preparations.*preparation_version=1/s)
  assert.match(f.calls[3], /p.source_checksum=\$3 AND p.mask_checksum=\$4/)
  assert.ok(f.calls.every(sql => !/^(INSERT|UPDATE|BEGIN|COMMIT)/.test(sql)))
})

test('managed mask/source refuses ownership miss, expiry, consumed/pending state, checksum drift, missing mirror and geometry/type mismatch', async () => {
  for (const options of [{ missingSource: true }, { unprepared: true }, { expired: true }, { status: 'pending' }, { status: 'attached' }, { checksum: 'c'.repeat(64) },
    { mirrorMissing: true }, { dimensions: true }, { kind: 'video' }]) {
    const f = fixture(options)
    await assert.rejects(lockManagedGenerationInputs(f.client, f.prepared, bindings))
  }
  const replay = fixture({ status: 'attached' })
  assert.equal((await lockManagedGenerationInputs(replay.client, replay.prepared, bindings, 'job')).length, 2)
})

test('managed edit refuses unbound inputs, extra roles, unpaired masks and pooled byte overflow', async () => {
  const f = fixture()
  await assert.rejects(lockManagedGenerationInputs(f.client, f.prepared, bindings.slice(0, 1)))
  f.prepared.runtimeLimits.maxTotalBytes = 150
  await assert.rejects(lockManagedGenerationInputs(f.client, f.prepared, bindings))
  const maskOnly = fixture()
  maskOnly.prepared.command.normalizedInputs = maskOnly.prepared.command.normalizedInputs.slice(1)
  await assert.rejects(lockManagedGenerationInputs(maskOnly.client, maskOnly.prepared, bindings.slice(1)))
})

test('effect hash covers final prompt/parameters/input byte identities/media revision/pricing', () => {
  const prepared = { snapshot: { frozenPayload: { modelId: 'model', prompt: 'draw', parameters: { size: '1024x1024' }, inputs: [] } } } as unknown as PreparedGeneration
  const price = { pricingRevision: 'free-v1', amount: '0', currency: 'USD' }
  const original = generationEffectBindingHash(prepared, bindings, price, revisionId)
  assert.notEqual(generationEffectBindingHash(prepared, bindings, price, 'changed-revision'), original)
  assert.notEqual(generationEffectBindingHash(prepared, [{ ...bindings[0], checksum: 'd'.repeat(64) }, bindings[1]], price, revisionId), original)
  assert.notEqual(generationEffectBindingHash(prepared, bindings, { ...price, pricingRevision: 'free-v2' }, revisionId), original)
  prepared.snapshot.frozenPayload.prompt = 'changed'
  assert.notEqual(generationEffectBindingHash(prepared, bindings, price, revisionId), original)
})

const capabilities = { modes: ['text_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1,
  parameters: [{ name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 }], inputSlots: [] }
const model = { id: 'model', model_kind: 'image', revision_id: revisionId, revision: 1, revision_number: 1,
  capabilities, defaults: {}, revision_capabilities: capabilities, revision_defaults: {}, provider_id: 'provider', plugin_id: 'plugin', plugin_version: '1.0.0' }
const command = { ownerId, modelId: 'model', prompt: 'draw', parameters: { count: 1 }, normalizedInputs: [], idempotencyKey: 'key', expectedModelRevisionId: revisionId }
const limits = { maxImageBytes: 200, maxTotalBytes: 400, maxInputs: 4 }

test('Agent exact revision refuses preparation/locked revision drift even when normalized request is identical', async () => {
  const ports = { database: () => ({ query: async () => ({ rows: [model] }) }), runtimeLimits: async () => limits }
  await assert.rejects(prepareGeneration({ ...command, expectedModelRevisionId: 'different' }, ports), { code: 'MODEL_NOT_AVAILABLE' })
  const prepared = await prepareGeneration(command, ports)
  const writes: string[] = []
  await assert.rejects(createGenerationInTransaction({ async query(sql) {
    if (sql.includes('FROM generation_jobs')) return { rows: [] }
    if (sql.includes('FROM model_configs')) return { rows: [{ ...model, revision_id: 'different' }] }
    writes.push(sql)
    return { rows: [] }
  } }, prepared), { code: 'MODEL_NOT_AVAILABLE' })
  assert.deepEqual(writes, [])
})

test('exact approved prompt refuses automatic optimization and replay at a different pinned media revision', async () => {
  const prepared = await prepareGeneration(command, { database: () => ({ query: async () => ({ rows: [model] }) }), runtimeLimits: async () => limits })
  for (const replay of [true, false]) {
    await assert.rejects(createGenerationInTransaction({ async query(sql) {
      if (sql.includes('FROM generation_jobs')) return { rows: replay ? [{ model_id: 'model', model_revision_id: 'different', media_kind: 'image', normalized_request: prepared.snapshot.frozenPayload }] : [] }
      if (sql.includes('FROM model_configs')) return { rows: [model] }
      if (sql.includes('FROM prompt_optimization_settings')) return { rows: [{ enabled: true }] }
      assert.fail(`no writes expected: ${sql}`)
    } }, prepared), { code: replay ? 'IDEMPOTENCY_CONFLICT' : 'APPROVAL_CONFLICT' })
  }
})
