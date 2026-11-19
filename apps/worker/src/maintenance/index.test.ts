import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { db } from '@musecanvas/database'
import { cleanupMaintenance, maintenance, scheduleMaintenance } from './index'

const actorId = '11111111-1111-4111-8111-111111111111'
const deletionId = '22222222-2222-4222-8222-222222222222'
type Call = { sql: string; values?: unknown[] }

// Driver control-flow tests. Actual row locks/rollback/fencing are covered by the isolated PG fixture.
function cleanupFixture(t: TestContext, options: { failMedia?: boolean; pendingAsset?: boolean; protectedContent?: boolean; assets?: Array<Record<string, string>> } = {}) {
  const calls: Call[] = []
  let available = true, completed = false, staged = false, attempts = 0, lost = false
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql === 'BEGIN') staged = completed
      if (sql === 'COMMIT') completed = staged
      if (sql.startsWith('SELECT id FROM deletion_jobs')) return { rows: lost ? [] : [{ id: deletionId }] }
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: actorId }] }
      if (sql.startsWith('SELECT\n')) return { rows: [{ protected_content: options.protectedContent ?? false }] }
      if (sql.startsWith('SELECT 1 FROM asset_deletion_jobs')) return { rows: options.pendingAsset ? [{ pending: 1 }] : [] }
      if (sql.startsWith('UPDATE media_uploads')) {
        assert.deepEqual(values, [actorId])
        if (options.failMedia) throw new Error('injected media cleanup failure')
      }
      if (sql.startsWith('UPDATE deletion_jobs')) {
        if (sql.includes('completed_at=clock_timestamp()')) staged = true
        return { rows: lost ? [] : [{ id: deletionId }] }
      }
      return { rows: sql.includes('to_regclass') ? [{ agent_table: null }] : [] }
    },
    release() {},
  }
  t.mock.method(db(), 'connect', async () => client)
  t.mock.method(db(), 'query', async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('WITH ready') && sql.includes('UPDATE deletion_jobs j')) {
      if (!available || completed) return { rows: [] }
      available = false
      return { rows: [{ id: deletionId, user_id: actorId, claim_token: 'token' }] }
    }
    if (sql.startsWith('UPDATE deletion_jobs SET lease_expires_at')) return { rows: lost ? [] : [{ id: deletionId }] }
    if (sql.startsWith('UPDATE deletion_jobs SET attempts')) attempts += 1
    if (sql.startsWith('SELECT id,object_key,thumbnail_object_key')) return { rows: options.assets ?? [] }
    return { rows: [] }
  })
  return { calls, get completed() { return completed }, get attempts() { return attempts },
    loseLease() { lost = true }, allowMedia() { options.failMedia = false; available = true } }
}

test('account cleanup binds the owner and atomically completes only within a valid claim', async t => {
  const state = cleanupFixture(t)
  await maintenance()
  const media = state.calls.findIndex(call => call.sql.startsWith('UPDATE media_uploads'))
  const completion = state.calls.findIndex(call => call.sql.includes('SET completed_at=clock_timestamp()'))
  assert.deepEqual(state.calls[media]!.values, [actorId])
  assert.ok(completion > media)
  assert.deepEqual(state.calls[completion]!.values, [deletionId, 'token'])
  assert.match(state.calls[completion]!.sql, /lease_expires_at>clock_timestamp\(\)/)
  assert.equal(state.completed, true)
  assert.equal(state.attempts, 0)
  assert.ok(state.calls.slice(completion).some(call => call.sql === 'COMMIT'))
})

test('media cleanup failure rolls back finalization, retains committed cancel intent, and retries later', async t => {
  const state = cleanupFixture(t, { failMedia: true })
  await maintenance()
  assert.equal(state.completed, false)
  assert.equal(state.attempts, 1)
  assert.ok(state.calls.some(call => call.sql === 'ROLLBACK'))
  assert.ok(state.calls.some(call => call.sql === 'COMMIT'), 'preflight cancellation commits before finalization')
  assert.equal(state.calls.some(call => call.sql.startsWith('UPDATE users')), false)
  const retry = state.calls.find(call => call.sql.startsWith('UPDATE deletion_jobs SET attempts'))!
  assert.deepEqual(retry.values, [deletionId, 'token'])
  state.allowMedia()
  await maintenance()
  assert.equal(state.completed, true)
  assert.equal(state.attempts, 1)
})

test('bounded storage progress does not gate dispatch and deduplicates asset object keys', async t => {
  const state = cleanupFixture(t, { assets: [
    { id: 'asset-1', object_key: 'original', thumbnail_object_key: 'preview', poster_object_key: 'preview' },
    { id: 'asset-2', object_key: 'later' },
  ] })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const deleting = new Promise<void>(resolve => { started = resolve })
  let time = 0
  const removed: string[] = []
  const cleanup = cleanupMaintenance({ now: () => time, budgetMs: 10, deleteObject: async key => {
    removed.push(key)
    if (key === 'original') { started(); await blocked }
    if (key === 'preview') time = 10
  } })
  await deleting
  await scheduleMaintenance()
  assert.ok(state.calls.some(call => call.sql.includes('WITH ready')))
  release()
  await cleanup
  assert.deepEqual(removed, ['original', 'preview'])
  assert.equal(state.calls.filter(call => call.sql.startsWith('UPDATE assets SET deleted_at')).length, 1)
  assert.equal(state.completed, false)
})

test('account completion waits for pending object jobs of already soft-deleted assets', async t => {
  const state = cleanupFixture(t, { pendingAsset: true })
  await cleanupMaintenance()
  const pending = state.calls.find(call => call.sql.startsWith('SELECT 1 FROM asset_deletion_jobs'))!
  assert.doesNotMatch(pending.sql, /a.deleted_at IS NULL/)
  assert.deepEqual(pending.values, [actorId])
  assert.equal(state.completed, false)
  assert.equal(state.attempts, 0)
  assert.ok(state.calls.some(call => call.values?.includes('WAITING_OBJECT_DELETION')))
})

test('a lost claim after storage deletion cannot persist stale progress or complete the account', async t => {
  const state = cleanupFixture(t, { assets: [{ id: 'asset-1', object_key: 'original' }] })
  await cleanupMaintenance({ deleteObject: async () => state.loseLease() })
  assert.equal(state.calls.some(call => call.sql.startsWith('UPDATE assets SET deleted_at')), false)
  assert.equal(state.completed, false)
  assert.equal(state.attempts, 0)
  assert.ok(state.calls.some(call => call.sql === 'ROLLBACK'))
})

test('protected Agent content blocks before byte deletion and cannot silently complete', async t => {
  const state = cleanupFixture(t, { protectedContent: true })
  await cleanupMaintenance({ deleteObject: async () => assert.fail('protected account must not erase bytes') })
  assert.equal(state.completed, false)
  assert.equal(state.attempts, 0)
  assert.ok(state.calls.some(call => call.sql.includes('SET blocked_at=clock_timestamp()') && call.values?.includes('BLOCKED_AGENT_RETENTION_POLICY')))
  assert.ok(state.calls.some(call => call.sql === 'COMMIT'), 'cancel intent is durable before policy blocking')
  assert.equal(state.calls.some(call => call.sql.startsWith('DELETE FROM')), false)
})

test('maintenance cancellation appends media completion only for actual local terminal transitions and rolls back on Outbox failure', async t => {
  for (const initial of ['queued', 'retry_wait', 'running']) {
    let committed = initial
    let staged = initial
    let failOutbox = true
    const calls: string[] = []
    const client = { async query(sql: string) {
      calls.push(sql)
      if (sql === 'BEGIN') staged = committed
      else if (sql === 'COMMIT') committed = staged
      else if (sql.startsWith('SELECT status FROM generation_jobs')) return { rows: [{ status: staged }] }
      else if (sql.startsWith('UPDATE generation_jobs')) staged = 'canceled'
      else if (sql.includes("SELECT 'media.job.completed'")) {
        assert.equal(staged, 'canceled')
        if (failOutbox) throw new Error('OUTBOX_FAILED')
      }
      return { rows: [] }
    }, release() {} }
    const connection = t.mock.method(db(), 'connect', async () => client)
    const query = t.mock.method(db(), 'query', async (sql: string) => {
      if (sql.includes('SELECT id FROM generation_jobs')) return { rows: [{ id: 'job' }] }
      return { rows: [] }
    })
    await assert.rejects(scheduleMaintenance(), /OUTBOX_FAILED/)
    assert.equal(committed, initial)
    assert.equal(calls.at(-1), 'ROLLBACK')
    failOutbox = false
    await scheduleMaintenance()
    assert.equal(committed, 'canceled')
    assert.equal(calls.at(-1), 'COMMIT')
    assert.equal(calls.filter(sql => sql.includes("SELECT 'media.job.completed'")).length, 2)
    connection.mock.restore(); query.mock.restore()
  }
})
