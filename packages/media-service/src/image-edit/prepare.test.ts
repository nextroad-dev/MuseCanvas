import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createEditMask } from '@musecanvas/providers'
import type { ModelCapabilities } from '@musecanvas/contracts'
import { prepareImageEditCommand, createStableUploadIds } from './prepare'
import { storeReadyInputImage, claimKeyedInputRow, promoteKeyedInputRow, type ReadyInputWrite } from './input-rows'
import type { ImageEditStoragePorts, SqlClient } from '../ports'
import { MediaServiceError } from '../errors'

const ownerId = '11111111-1111-4111-8111-111111111111'
const assetId = '22222222-2222-4222-8222-222222222222'
const modelId = '33333333-3333-4333-8333-333333333333'
const capabilities: ModelCapabilities = {
  modes: ['text_to_image', 'image_to_image', 'inpaint'], declaredBy: 'plugin-manifest', maxCount: 1, supportedMediaKinds: ['image'],
  parameters: [{ name: 'size', type: 'enum', options: ['1024x1024'], defaultValue: '1024x1024' }],
  inputSlots: [
    { role: 'reference_image', allowedMediaKinds: ['image'], required: false, minCount: 0, maxCount: 1 },
    { role: 'mask', allowedMediaKinds: ['image'], required: false, minCount: 0, maxCount: 1 },
  ],
}
const bytes = await createEditMask({ imageWidth: 1024, imageHeight: 1024, selection: { x: 0, y: 0, width: 32, height: 32 } })

function fixture(owned = true) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const puts: string[] = []
  let inTransaction = false
  const client: SqlClient = { query: async (sql, params = []) => {
    queries.push({ sql, params })
    if (sql.includes('FROM model_configs')) return { rows: [{ id: modelId, model_kind: 'image', capabilities }] }
    if (sql.includes('FROM assets')) return { rows: owned ? [{ id: assetId, object_key: 'source.png', mime_type: 'image/png' }] : [] }
    return { rows: [] }
  } }
  const ports: ImageEditStoragePorts = {
    db: () => client,
    runTransaction: async fn => { assert.equal(inTransaction, false); inTransaction = true; try { await fn(client) } finally { inTransaction = false } },
    readObjectBytes: async () => { assert.equal(inTransaction, false); return bytes },
    putObjectBytes: async key => { assert.equal(inTransaction, false); puts.push(key) },
    putReservedMask: async key => { assert.equal(inTransaction, false); puts.push(key) },
    deleteObject: async () => { assert.equal(inTransaction, false) },
    uploadLimits: async () => ({ maxImageBytes: 10_000_000, uploadTtlSeconds: 3600 }),
  }
  return { ports, queries, puts }
}
const input = () => ({ ownerId, modelId, prompt: 'Replace the selection', assetId, selection: { x: 32, y: 32, width: 64, height: 64 }, stableUploadIds: createStableUploadIds('owner:key') })

test('non-HTTP image edit preparation computes stable artifacts without staging on dry run', async () => {
  const f = fixture()
  const first = await prepareImageEditCommand({ ...input(), ports: f.ports, dryRun: true })
  const second = await prepareImageEditCommand({ ...input(), ports: f.ports, dryRun: true })
  assert.equal(first.success, true)
  assert.equal(second.success, true)
  if (!first.success || !second.success) return
  assert.deepEqual(first.data, second.data)
  assert.deepEqual(first.data.inputs[0], { assetId, role: 'reference_image', position: 0 })
  assert.equal(first.data.sourceChecksum, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(first.data.parameters.count, 1)
  assert.equal(f.puts.length, 0)
  assert.ok(!f.queries.some(s => /INSERT|UPDATE/.test(s.sql)))
  assert.deepEqual(f.queries.find(s => s.sql.includes('FROM assets'))!.params, [assetId, ownerId])
})

test('reserved mask persistence fences immutable storage outside generation transactions', async () => {
  const f = fixture()
  const uploadId = '44444444-4444-4444-8444-444444444444'
  let persisted: ReadyInputWrite | undefined
  const result = await prepareImageEditCommand({ ...input(), ports: f.ports, reservedMask: {
    uploadId, expiresAt: '2099-01-01T00:00:00Z', persist: async (row, put) => {
      persisted = row
      assert.equal(f.puts.length, 0)
      await put()
    },
  } })
  assert.equal(result.success, true)
  assert.equal(persisted?.uploadId, uploadId)
  assert.equal(persisted?.actorId, ownerId)
  assert.deepEqual(f.puts, [`inputs/${ownerId}/${uploadId}.png`])
  const denied = fixture()
  const rejected = await prepareImageEditCommand({ ...input(), ports: denied.ports, reservedMask: {
    uploadId, expiresAt: '2099-01-01T00:00:00Z', persist: async () => { throw new Error('PREPARATION_LEASE_LOST') },
  } })
  assert.equal(rejected.success, false)
  if (!rejected.success) assert.ok(rejected.error instanceof MediaServiceError)
  assert.equal(denied.puts.length, 0)
})

test('owner denial returns a typed error before reading or writing storage', async () => {
  const f = fixture(false)
  const result = await prepareImageEditCommand({ ...input(), ports: f.ports })
  assert.equal(result.success, false)
  if (!result.success) {
    assert.ok(result.error instanceof MediaServiceError)
    assert.equal(result.error.code, 'NOT_FOUND')
    assert.equal(result.error.status, 404)
  }
  assert.equal(f.puts.length, 0)
})

test('all staging row primitives propagate SQL errors immediately for caller rollback', async () => {
  const row: ReadyInputWrite = { uploadId: assetId, actorId: ownerId, objectKey: 'source.png', mimeType: 'image/png', width: 1024, height: 1024, sizeBytes: bytes.length, checksum: 'checksum', ttlSeconds: 3600 }
  for (const write of [storeReadyInputImage, claimKeyedInputRow, promoteKeyedInputRow]) {
    const statements: string[] = []
    const failure = Object.assign(new Error('synthetic missing schema'), { code: '42P01' })
    const client: SqlClient = { query: async sql => { statements.push(sql); throw failure } }
    await assert.rejects(write(client, row), error => error === failure)
    assert.equal(statements.length, 1)
    assert.match(statements[0], /media_uploads/)
  }
})
