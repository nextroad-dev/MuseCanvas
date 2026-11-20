import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { db } from '@musecanvas/database'
import type { Actor } from '../../auth/security'
import { upsertModel } from './handlers'

const MODEL_ID = randomUUID()
const ACTOR_ID = randomUUID()
const CREDENTIAL_A = randomUUID()
const admin: Actor = { id: ACTOR_ID, email: 'admin@example.test', role: 'admin', status: 'active', createdAt: new Date().toISOString() }

/** A live preset-backed image model, as the admin page would load it. */
function modelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL_ID,
    preset_id: 'seedream-4-5',
    display_name: 'Seedream 4.5',
    adapter: 'seedream',
    vendor_model_id: 'doubao-seedream-4-5-251128',
    base_url: 'https://ark.cn-beijing.volces.com',
    model_kind: 'image',
    enabled: true,
    is_default: false,
    concurrency_limit: 1,
    sort_order: 0,
    provider_credential_id: null,
    latest_revision_id: null,
    provider_id: 'volcengine',
    plugin_id: 'seedream-image',
    plugin_version: '1.1.0',
    watermark: false,
    sizes: '[]',
    quality_options: '[]',
    max_count: 1,
    max_input_images: 4,
    ...overrides,
  }
}

function revisionRow(id: string, revision: number, credentialId: string | null = null): Record<string, unknown> {
  return {
    id,
    model_id: MODEL_ID,
    revision,
    provider_id: 'volcengine',
    plugin_id: 'seedream-image',
    plugin_version: '1.1.0',
    vendor_model_id: 'doubao-seedream-4-5-251128',
    base_url: 'https://ark.cn-beijing.volces.com',
    credential_id: credentialId,
    credential_schema_version: 1,
    capabilities: {},
    normalized_config: {},
    defaults: {},
    snapshot_digest: `digest-${id}`,
    created_by: ACTOR_ID,
    created_at: new Date('2026-11-20T00:00:00Z'),
  }
}

function transactionClient(
  statements: string[],
  handler: (sql: string, args: unknown[]) => { rows: Record<string, unknown>[] },
) {
  return {
    release() { /* fixture owns no connection */ },
    async query(sql: string, args: unknown[] = []) {
      statements.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      return handler(sql, args)
    },
  }
}

/** The preset path re-validates a stored credential before saving. */
function credentialRow(id: string): Record<string, unknown> {
  return {
    id,
    display_name: 'Volcengine A',
    provider_id: 'volcengine',
    schema_id: 'legacy-api-key-v1',
    schema_version: 1,
    base_url: 'https://ark.cn-beijing.volces.com',
    enabled: true,
    deleted_at: null,
  }
}

function mockExisting(row: Record<string, unknown>, credentialIds: string[] = []): () => void {
  const mocked = mock.method(db(), 'query', async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT * FROM model_configs')) return { rows: [row] }
    if (sql.startsWith('SELECT * FROM provider_credentials')) {
      const id = String(args[0])
      return { rows: credentialIds.includes(id) ? [credentialRow(id)] : [] }
    }
    throw new Error(`unexpected pool query: ${sql}`)
  })
  return () => mocked.mock.restore()
}

function presetClient(
  statements: string[],
  options: { matching?: { id: string; revision: number } | null; maxRevision?: number; inserted?: Record<string, unknown> } = {},
) {
  return transactionClient(statements, (sql, args) => {
    if (sql.startsWith('UPDATE model_configs') && sql.includes('RETURNING *')) return { rows: [modelRow()] }
    if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    if (sql.startsWith('SELECT schema_version FROM provider_credentials')) return { rows: [{ schema_version: 1 }] }
    if (sql.startsWith('SELECT id,revision FROM model_config_revisions')) return { rows: options.matching ? [options.matching] : [] }
    if (sql.includes('SELECT COALESCE(MAX(revision),0) AS max_revision')) return { rows: [{ max_revision: options.maxRevision ?? 0 }] }
    if (sql.startsWith('SELECT id FROM model_configs WHERE id = $1 FOR UPDATE')) return { rows: [{ id: MODEL_ID }] }
    if (sql.includes('SELECT COALESCE(MAX(revision), 0) + 1')) return { rows: [{ next_rev: (options.maxRevision ?? 0) + 1 }] }
    if (sql.startsWith('INSERT INTO model_config_revisions')) {
      const credentials = args[7] as string | null
      return { rows: [options.inserted ?? revisionRow(String(args[0] ?? 'rev-new'), Number(args[1] ?? 1), credentials)] }
    }
    if (sql.startsWith('UPDATE model_configs SET latest_revision_id')) return { rows: [] }
    throw new Error(`unexpected transaction query: ${sql}`)
  })
}

test('preset save rolls back the model row and audit when the revision snapshot fails', async t => {
  t.mock.method(console, 'error', () => {})
  const restoreRead = mockExisting(modelRow())
  const statements: string[] = []
  const connect = mock.method(db(), 'connect', async () => transactionClient(statements, (sql) => {
    if (sql.startsWith('UPDATE model_configs')) return { rows: [modelRow()] }
    if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    if (sql.startsWith('SELECT id,revision FROM model_config_revisions')) throw new Error('REVISION_UNAVAILABLE')
    throw new Error(`unexpected transaction query: ${sql}`)
  }))
  try {
    const response = await upsertModel(admin, { presetId: 'seedream-4-5' }, MODEL_ID)
    assert.equal(response.status, 500)
    const payload = await response.json() as { success: boolean; error?: { code: string } }
    assert.equal(payload.success, false)
    assert.equal(payload.error?.code, 'MODEL_REVISION_UNAVAILABLE')
    assert.ok(statements.includes('BEGIN'))
    assert.ok(statements.some(sql => sql.startsWith('UPDATE model_configs')))
    assert.ok(statements.some(sql => sql.startsWith('INSERT INTO audit_logs')))
    assert.ok(statements.includes('ROLLBACK'), 'the committed model write must be undone')
    assert.equal(statements.includes('COMMIT'), false, 'a model without a revision must never commit')
  } finally {
    connect.mock.restore()
    restoreRead()
  }
})

test('preset save commits the model row, audit and new revision together', async () => {
  const restoreRead = mockExisting(modelRow())
  const statements: string[] = []
  const revisionId = randomUUID()
  const connect = mock.method(db(), 'connect', async () => presetClient(statements, {
    inserted: revisionRow(revisionId, 1),
  }))
  try {
    const response = await upsertModel(admin, { presetId: 'seedream-4-5' }, MODEL_ID)
    assert.equal(response.status, 200)
    const payload = await response.json() as { success: boolean; data: Record<string, unknown> }
    assert.equal(payload.success, true)
    assert.equal(payload.data.revision, 1)
    assert.equal(payload.data.latestRevisionId, revisionId)
    assert.deepEqual(statements.filter(sql => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'), ['BEGIN', 'COMMIT'])
    assert.ok(
      statements.findIndex(sql => sql.startsWith('INSERT INTO model_config_revisions'))
        < statements.indexOf('COMMIT'),
      'the revision insert belongs to the same transaction as the model write',
    )
  } finally {
    connect.mock.restore()
    restoreRead()
  }
})

test('re-saving a state that matches an older revision appends a new one instead of pointing latest backwards', async () => {
  // A(B credential) -> B -> A: the digest matches revision 1, but revision 2 is
  // still the newest. Reusing 1 would make latest_revision_id disagree with the
  // Worker fallback (MAX revision), so the save must append revision 3.
  const restoreRead = mockExisting(modelRow({ provider_credential_id: CREDENTIAL_A }), [CREDENTIAL_A])
  const statements: string[] = []
  const newRevisionId = randomUUID()
  const connect = mock.method(db(), 'connect', async () => presetClient(statements, {
    matching: { id: 'rev-a', revision: 1 },
    maxRevision: 2,
    inserted: revisionRow(newRevisionId, 3, CREDENTIAL_A),
  }))
  try {
    const response = await upsertModel(admin, { presetId: 'seedream-4-5' }, MODEL_ID)
    assert.equal(response.status, 200)
    const payload = await response.json() as { data: Record<string, unknown> }
    assert.equal(payload.data.revision, 3)
    assert.equal(payload.data.latestRevisionId, newRevisionId)
    assert.ok(statements.some(sql => sql.startsWith('INSERT INTO model_config_revisions')))
    const pointer = statements.find(sql => sql.startsWith('UPDATE model_configs SET latest_revision_id'))
    assert.ok(pointer)
    assert.equal(payload.data.latestRevisionId, newRevisionId)
  } finally {
    connect.mock.restore()
    restoreRead()
  }
})

test('an unchanged save reuses only the newest matching revision', async () => {
  const restoreRead = mockExisting(modelRow({ provider_credential_id: CREDENTIAL_A }), [CREDENTIAL_A])
  const statements: string[] = []
  const connect = mock.method(db(), 'connect', async () => presetClient(statements, {
    matching: { id: 'rev-2', revision: 2 },
    maxRevision: 2,
  }))
  try {
    const response = await upsertModel(admin, { presetId: 'seedream-4-5' }, MODEL_ID)
    assert.equal(response.status, 200)
    const payload = await response.json() as { data: Record<string, unknown> }
    assert.equal(payload.data.revision, 2)
    assert.equal(payload.data.latestRevisionId, 'rev-2')
    assert.equal(statements.some(sql => sql.startsWith('INSERT INTO model_config_revisions')), false)
    assert.ok(statements.some(sql => sql.startsWith('UPDATE model_configs SET latest_revision_id')))
  } finally {
    connect.mock.restore()
    restoreRead()
  }
})

test('plugin save pins the credential the database persisted, not an omitted request field', async () => {
  const restoreRead = mockExisting(modelRow({ provider_credential_id: CREDENTIAL_A }), [CREDENTIAL_A])
  const statements: string[] = []
  const revisionId = randomUUID()
  const connect = mock.method(db(), 'connect', async () => transactionClient(statements, (sql, args) => {
    // An explicit null on the plugin path means "keep the stored credential".
    if (sql.startsWith('UPDATE model_configs') && sql.includes('RETURNING *')) {
      return { rows: [modelRow({ provider_credential_id: CREDENTIAL_A })] }
    }
    if (sql.startsWith('SELECT schema_version FROM provider_credentials')) return { rows: [{ schema_version: 3 }] }
    if (sql.startsWith('SELECT id FROM model_configs WHERE id = $1 FOR UPDATE')) return { rows: [{ id: MODEL_ID }] }
    if (sql.includes('SELECT COALESCE(MAX(revision), 0) + 1')) return { rows: [{ next_rev: 1 }] }
    if (sql.startsWith('INSERT INTO model_config_revisions')) {
      assert.equal(args[7], CREDENTIAL_A, 'revision must pin the persisted credential')
      assert.equal(args[8], 3, 'revision must pin the credential schema actually stored')
      return { rows: [revisionRow(revisionId, 1, CREDENTIAL_A)] }
    }
    if (sql.startsWith('UPDATE model_configs SET latest_revision_id')) return { rows: [] }
    if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    throw new Error(`unexpected transaction query: ${sql}`)
  }))
  try {
    const response = await upsertModel(admin, {
      pluginId: 'seedream-image',
      pluginVersion: '1.1.0',
      providerCredentialId: null,
    }, MODEL_ID)
    assert.equal(response.status, 200)
    const payload = await response.json() as { data: Record<string, unknown> }
    assert.equal(payload.data.providerCredentialId, CREDENTIAL_A)
  } finally {
    connect.mock.restore()
    restoreRead()
  }
})
