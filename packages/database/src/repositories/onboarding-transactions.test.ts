import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {
  updateRuntimeSettings,
  updateSiteSettings,
  updateSmtpSettings,
  updateStorageSettings,
} from './onboarding'

const updatedAt = new Date('2026-10-25T12:00:00.000Z')
const actor = '00000000-0000-0000-0000-000000000001'
type Client = pg.Pool | pg.PoolClient
interface SettingsCase {
  name: string
  table: string
  row: Record<string, unknown>
  params: unknown[]
  sectionStatus: 'complete' | 'pending'
  update: (client: Client) => Promise<{ revision: number; updatedAt: string }>
}
const cases: SettingsCase[] = [
  {
    name: 'site', table: 'app_settings', sectionStatus: 'complete',
    row: { site_name: 'Existing', site_url: 'https://example.test' },
    params: ['Renamed', 'https://example.test', actor],
    update: client => updateSiteSettings(client, { siteName: 'Renamed' }, actor),
  },
  {
    name: 'smtp', table: 'smtp_settings', sectionStatus: 'complete',
    row: { host: 'smtp.example.test', port: 587, tls_mode: 'starttls', username: 'mailer',
      from_address: 'mail@example.test', from_name: 'Existing', status: 'verified',
      password_encrypted: 'opaque-test-ciphertext', password_fingerprint: 'test-fingerprint',
      encryption_key_id: 'test-key-id' },
    params: ['smtp.example.test', 587, 'starttls', 'mailer', 'mail@example.test', 'Renamed',
      'verified', 'opaque-test-ciphertext', 'test-fingerprint', 'test-key-id', actor],
    update: client => updateSmtpSettings(client, { fromName: 'Renamed' }, actor),
  },
  {
    name: 'storage', table: 'object_storage_settings', sectionStatus: 'pending',
    row: { endpoint: 'https://storage.example.test', public_endpoint: null, region: 'test-region',
      bucket: 'existing', access_key_id: 'test-access-id', signed_url_ttl_seconds: 600,
      status: 'configured', secret_encrypted: 'opaque-test-ciphertext',
      secret_fingerprint: 'test-fingerprint', encryption_key_id: 'test-key-id',
      storage_driver: 's3', local_root: null },
    params: ['https://storage.example.test', null, 'test-region', 'renamed', 'test-access-id',
      600, 'configured', 'opaque-test-ciphertext', 'test-fingerprint', 'test-key-id', actor, 's3', null],
    update: client => updateStorageSettings(client, { bucket: 'renamed' }, actor),
  },
  {
    name: 'runtime', table: 'runtime_settings', sectionStatus: 'complete',
    row: { upload_ttl_seconds: 3600, signed_url_ttl_seconds: 600, max_image_bytes: 1000,
      max_total_bytes: 2000, max_inputs: 2, provider_timeout_ms: 3000,
      max_output_bytes: 4000, job_lease_ms: 5000 },
    params: [3600, 600, 1000, 2000, 3, 3000, 4000, 5000, actor],
    update: client => updateRuntimeSettings(client, { maxInputs: 3 }, actor),
  },
]

function mockConnection(settings: SettingsCase, failAt?: string, missingState = false) {
  const calls: string[] = []
  const failure = new Error(`Failed ${failAt}`)
  const connection = {
    query: async (rawSql: string, params: unknown[] = []) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim()
      const step = sql.startsWith('SELECT') ? 'LOCK'
        : sql.startsWith('UPDATE onboarding_state') ? 'SECTION'
          : sql.startsWith('UPDATE') ? 'SETTINGS' : sql
      calls.push(step)
      if (step === failAt) throw failure
      if (step === 'LOCK') {
        assert.equal(sql, `SELECT * FROM ${settings.table} WHERE singleton = true FOR UPDATE`)
        return { rows: [{ ...settings.row, revision: 1, updated_at: updatedAt }] }
      }
      if (step === 'SETTINGS') {
        assert.ok(sql.startsWith(`UPDATE ${settings.table} SET `))
        assert.deepEqual(params, settings.params, 'partial updates preserve locked values and opaque secrets')
        return { rows: [{ ...settings.row, revision: 2, updated_at: updatedAt }] }
      }
      if (step === 'SECTION') {
        assert.ok(sql.includes(`${settings.name}_status = $1`))
        assert.deepEqual(params, [settings.sectionStatus, actor])
        return { rows: missingState ? [] : [{ status: 'pending', config_revision: 2,
          claim_token_hash: null, updated_at: updatedAt }] }
      }
      return { rows: [] }
    },
    release: () => { calls.push('RELEASE') },
  } as unknown as pg.PoolClient
  const pool = Object.create(pg.Pool.prototype) as pg.Pool
  pool.connect = (async () => {
    calls.push('CONNECT')
    if (failAt === 'CONNECT') throw failure
    return connection
  }) as typeof pool.connect
  pool.query = (() => { throw new Error('Must not use Pool.query for transactional writes') }) as typeof pool.query
  return { connection, pool, calls, failure }
}

for (const settings of cases) {
  test(`${settings.name}: Pool uses one connection for lock, settings and section before committing`, async () => {
    const { pool, calls } = mockConnection(settings)
    const saved = await settings.update(pool)
    assert.equal(saved.revision, 2)
    assert.equal(saved.updatedAt, updatedAt.toISOString())
    assert.deepEqual(calls, ['CONNECT', 'BEGIN', 'LOCK', 'SETTINGS', 'SECTION', 'COMMIT', 'RELEASE'])
  })

  test(`${settings.name}: caller-owned PoolClient is never begun, committed or released`, async () => {
    const { connection, calls } = mockConnection(settings)
    await settings.update(connection)
    assert.deepEqual(calls, ['LOCK', 'SETTINGS', 'SECTION'])
  })

  for (const phase of ['BEGIN', 'LOCK', 'SETTINGS', 'SECTION', 'COMMIT']) {
    test(`${settings.name}: Pool failure at ${phase} rolls back and releases`, async () => {
      const { pool, calls, failure } = mockConnection(settings, phase)
      await assert.rejects(settings.update(pool), error => error === failure)
      const steps = ['BEGIN', 'LOCK', 'SETTINGS', 'SECTION', 'COMMIT']
      assert.deepEqual(calls, ['CONNECT', ...steps.slice(0, steps.indexOf(phase) + 1), 'ROLLBACK', 'RELEASE'])
    })
  }

  test(`${settings.name}: missing onboarding state rolls back settings rather than committing`, async () => {
    const { pool, calls } = mockConnection(settings, undefined, true)
    await assert.rejects(settings.update(pool), /ONBOARDING_STATE_MISSING/)
    assert.deepEqual(calls, ['CONNECT', 'BEGIN', 'LOCK', 'SETTINGS', 'SECTION', 'ROLLBACK', 'RELEASE'])
  })

  test(`${settings.name}: client errors propagate without rolling back caller's transaction`, async () => {
    const { connection, calls, failure } = mockConnection(settings, 'SECTION')
    await assert.rejects(settings.update(connection), error => error === failure)
    assert.deepEqual(calls, ['LOCK', 'SETTINGS', 'SECTION'])
  })

  test(`${settings.name}: failed acquisition does not begin or release a connection`, async () => {
    const { pool, calls, failure } = mockConnection(settings, 'CONNECT')
    await assert.rejects(settings.update(pool), error => error === failure)
    assert.deepEqual(calls, ['CONNECT'])
  })
}
