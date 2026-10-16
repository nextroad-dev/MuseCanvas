import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { db } from '@musecanvas/database'
import type { Actor } from '../../auth/security'
import { publicModelDto } from '../../shared/dto'
import { readMediaModelDefaults, updateMediaModelDefaults } from './media-model-defaults'
import { defaultDisableBlocked, deleteModel, upsertModel } from '../models/handlers'
import { listPublicModels } from '../models/queries'

const IMAGE_ID = randomUUID()
const IMAGE_ID_2 = randomUUID()
const VIDEO_ID = randomUUID()
const ACTOR_ID = randomUUID()

const admin: Actor = { id: ACTOR_ID, email: 'admin@example.test', role: 'admin', status: 'active', createdAt: new Date().toISOString() }
const user: Actor = { ...admin, role: 'user' }

function poolClient(handler: (sql: string, args: unknown[]) => { rows: Record<string, unknown>[] }) {
  const calls: { sql: string; args: unknown[] }[] = []
  let released = false
  const client = {
    release: () => { released = true },
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      return handler(sql, args)
    },
  }
  const mocked = mock.method(db(), 'connect', async () => client)
  return { calls, restore: () => mocked.mock.restore(), released: () => released }
}

function mockQuery(handler: (sql: string, args: unknown[]) => { rows: Record<string, unknown>[] }) {
  const calls: { sql: string; args: unknown[] }[] = []
  const mocked = mock.method(db(), 'query', async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args })
    return handler(sql, args)
  })
  return { calls, restore: () => mocked.mock.restore() }
}

async function codeOf(response: Response): Promise<[number, string]> {
  const payload = await response.json() as { success: boolean; error?: { code: string } }
  return [response.status, payload.success ? '' : payload.error?.code ?? '']
}

test('non-admin reads and writes are refused with 403 before any database access', async () => {
  const f = mockQuery(() => { throw new Error('must not query') })
  try {
    assert.deepEqual(await codeOf(await readMediaModelDefaults(user)), [403, 'FORBIDDEN'])
    assert.deepEqual(await codeOf(await updateMediaModelDefaults(user, { imageModelId: IMAGE_ID })), [403, 'FORBIDDEN'])
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

test('read maps live defaults per kind and nulls the unset kind', async () => {
  const f = mockQuery(() => ({ rows: [{ id: IMAGE_ID, model_kind: 'image', updated_at: new Date('2026-10-16T00:00:00Z') }] }))
  try {
    const response = await readMediaModelDefaults(admin)
    assert.equal(response.status, 200)
    const data = (await response.json()).data
    assert.equal(data.imageModelId, IMAGE_ID)
    assert.equal(data.videoModelId, null)
    assert.equal(data.updatedAt, '2026-10-16T00:00:00.000Z')
  } finally { f.restore() }
})

test('update rejects unparseable patches without opening a transaction', async () => {
  const f = poolClient(() => { throw new Error('must not query') })
  try {
    for (const input of [{}, { imageModelId: 'not-a-uuid' }, { videoModelId: 42 }, { role: 'admin' }]) {
      const [status, code] = await codeOf(await updateMediaModelDefaults(admin, input))
      assert.equal(status, 400)
      assert.equal(code, 'INVALID_INPUT')
    }
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

test('update rejects missing, deleted, disabled and wrong-kind rows with 400 and rolls back', async () => {
  const variants: Array<{ rows: Record<string, unknown>[]; label: string }> = [
    { rows: [], label: 'missing' },
    { rows: [{ id: IMAGE_ID, model_kind: 'image', enabled: true, deleted_at: new Date() }], label: 'deleted' },
    { rows: [{ id: IMAGE_ID, model_kind: 'image', enabled: false, deleted_at: null }], label: 'disabled' },
    { rows: [{ id: IMAGE_ID, model_kind: 'video', enabled: true, deleted_at: null }], label: 'wrong-kind' },
  ]
  for (const variant of variants) {
    const f = poolClient((sql) => {
      if (sql.startsWith('SELECT id, model_kind, enabled, deleted_at FROM model_configs')) return variant
      throw new Error(`unexpected query: ${sql}`)
    })
    try {
      const [status, code] = await codeOf(await updateMediaModelDefaults(admin, { imageModelId: IMAGE_ID }))
      assert.deepEqual([status, code], [400, 'DEFAULT_MODEL_INVALID'], variant.label)
      assert.ok(f.calls.some(call => call.sql === 'ROLLBACK'), variant.label)
      assert.equal(f.calls.some(call => call.sql === 'COMMIT'), false, variant.label)
      assert.equal(f.calls.some(call => call.sql.startsWith('INSERT INTO audit_logs')), false, variant.label)
    } finally { f.restore() }
  }
})

test('update elects a new default, clears the old one and audits in one transaction', async () => {
  const f = poolClient((sql) => {
    if (sql.startsWith('SELECT id, model_kind, enabled, deleted_at FROM model_configs')) {
      return { rows: [{ id: IMAGE_ID_2, model_kind: 'image', enabled: true, deleted_at: null }] }
    }
    if (sql.startsWith('SELECT id, model_kind, updated_at FROM model_configs')) {
      return { rows: [{ id: IMAGE_ID_2, model_kind: 'image', updated_at: new Date('2026-10-16T01:00:00Z') }] }
    }
    if (sql.startsWith('UPDATE model_configs') || sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    throw new Error(`unexpected query: ${sql}`)
  })
  try {
    const response = await updateMediaModelDefaults(admin, { imageModelId: IMAGE_ID_2 })
    assert.equal(response.status, 200)
    const data = (await response.json()).data
    assert.equal(data.imageModelId, IMAGE_ID_2)
    assert.equal(data.videoModelId, null)
    const clear = f.calls.find(call => call.sql.startsWith('UPDATE model_configs SET is_default=false'))
    assert.deepEqual(clear?.args, ['image', IMAGE_ID_2])
    const set = f.calls.find(call => call.sql.startsWith('UPDATE model_configs SET is_default=true'))
    assert.deepEqual(set?.args, [IMAGE_ID_2])
    const audit = f.calls.find(call => call.sql.startsWith('INSERT INTO audit_logs'))
    assert.equal(audit?.args[0], ACTOR_ID)
    assert.equal(audit?.args[1], 'media_model_defaults.update')
    const updateIndex = f.calls.findIndex(call => call.sql.startsWith('UPDATE model_configs'))
    const auditIndex = f.calls.findIndex(call => call.sql.startsWith('INSERT INTO audit_logs'))
    const commitIndex = f.calls.findIndex(call => call.sql === 'COMMIT')
    assert.ok(updateIndex < auditIndex && auditIndex < commitIndex)
  } finally { f.restore() }
})

test('update accepts explicit null as a clear', async () => {
  const f = poolClient((sql) => {
    if (sql.startsWith('SELECT id, model_kind, updated_at FROM model_configs')) {
      return { rows: [{ id: IMAGE_ID, model_kind: 'image', updated_at: new Date('2026-10-16T00:00:00Z') }] }
    }
    if (sql.startsWith('UPDATE model_configs') || sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    throw new Error(`unexpected query: ${sql}`)
  })
  try {
    const response = await updateMediaModelDefaults(admin, { videoModelId: null })
    assert.equal(response.status, 200)
    const data = (await response.json()).data
    assert.equal(data.imageModelId, IMAGE_ID)
    assert.equal(data.videoModelId, null)
    const clear = f.calls.find(call => call.sql.startsWith('UPDATE model_configs SET is_default=false'))
    assert.deepEqual(clear?.args, ['video'])
  } finally { f.restore() }
})

test('publicModelDto carries isDefault and listPublicModels serves it', async () => {
  const row = { id: IMAGE_ID, display_name: 'M', adapter: 'openai', enabled: true, sort_order: 0 }
  assert.equal(publicModelDto({ ...row, is_default: true }).isDefault, true)
  assert.equal(publicModelDto({ ...row, is_default: false }).isDefault, false)
  // Rows read before the migration (or without the column) default to false.
  assert.equal(publicModelDto(row).isDefault, false)

  const f = mockQuery(() => ({ rows: [{ ...row, model_kind: 'image', is_default: true }] }))
  try {
    const response = await listPublicModels()
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data[0].isDefault, true)
  } finally { f.restore() }
})

test('defaultDisableBlocked only fires on the true-to-false transition of a live media default', () => {
  const live = { is_default: true, model_kind: 'image', enabled: true }
  assert.equal(defaultDisableBlocked(live, false), true)
  assert.equal(defaultDisableBlocked(live, true), false)
  assert.equal(defaultDisableBlocked({ ...live, model_kind: 'video' }, false), true)
  assert.equal(defaultDisableBlocked({ ...live, model_kind: 'language' }, false), false)
  assert.equal(defaultDisableBlocked({ ...live, enabled: false }, false), false)
  assert.equal(defaultDisableBlocked({ ...live, is_default: false }, false), false)
  assert.equal(defaultDisableBlocked(null, false), false)
  assert.equal(defaultDisableBlocked(undefined, false), false)
})

test('preset-path upsert refuses to switch off a live default with 409 before any write', async () => {
  const existing = {
    id: IMAGE_ID, preset_id: null, model_kind: 'image', enabled: true, is_default: true,
    provider_credential_id: null, display_name: 'M', sort_order: 0,
  }
  const f = mockQuery((sql) => {
    if (sql.startsWith('SELECT * FROM model_configs')) return { rows: [existing] }
    throw new Error(`must not write: ${sql}`)
  })
  try {
    const [status, code] = await codeOf(await upsertModel(admin, { enabled: false }, IMAGE_ID))
    assert.deepEqual([status, code], [409, 'DEFAULT_MODEL_IN_USE'])
    assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE')), false)
  } finally { f.restore() }
})

test('deleteModel refuses a live default with 409 and deletes anything else', async () => {
  let f = poolClient((sql) => {
    if (sql.startsWith('SELECT is_default, model_kind FROM model_configs')) {
      return { rows: [{ is_default: true, model_kind: 'video' }] }
    }
    throw new Error(`must not write: ${sql}`)
  })
  try {
    const [status, code] = await codeOf(await deleteModel(admin, VIDEO_ID))
    assert.deepEqual([status, code], [409, 'DEFAULT_MODEL_IN_USE'])
    assert.equal(f.calls.some(call => call.sql.includes('deleted_at=now()')), false)
  } finally { f.restore() }
  // A non-default row still deletes and audits in the same transaction.
  f = poolClient((sql) => {
    if (sql.startsWith('SELECT is_default, model_kind FROM model_configs')) return { rows: [{ is_default: false, model_kind: 'image' }] }
    if (sql.startsWith('UPDATE model_configs')) return { rows: [{ id: IMAGE_ID }] }
    if (sql.startsWith('INSERT INTO audit_logs') || sql.startsWith('UPDATE prompt_optimization_settings')) return { rows: [] }
    throw new Error(`unexpected query: ${sql}`)
  })
  try {
    const response = await deleteModel(admin, IMAGE_ID)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, { deleted: true })
    assert.ok(f.calls.some(call => call.sql === 'COMMIT'))
  } finally { f.restore() }
})
