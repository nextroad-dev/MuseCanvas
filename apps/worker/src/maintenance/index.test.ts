import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type pg from 'pg'
import { db } from '@musecanvas/database'
import { maintenance } from './index'

const actorId = '11111111-1111-4111-8111-111111111111'
const deletionId = '22222222-2222-4222-8222-222222222222'

type Call = { sql: string; values?: unknown[] }

// Exercise maintenance and the real transaction helper without a network or
// credentials. These tests verify transaction commands and retry control flow;
// PostgreSQL's rollback semantics still require an integration environment.
function mockCleanupDb(t: TestContext, failMediaUpdate = false) {
  const pool = db()
  const calls: Call[] = []
  let attempts = 0
  let completed = false
  let releases = 0
  let fail = failMediaUpdate
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.startsWith('UPDATE media_uploads')) {
        assert.deepEqual(values, [actorId], 'media cleanup must bind the account id')
        if (fail) throw new Error('injected media cleanup failure')
      }
      if (sql.startsWith('UPDATE deletion_jobs')) completed = true
      return { rows: sql.includes('to_regclass') ? [{ agent_table: null }] : [] }
    },
    release() { releases += 1 },
  } as unknown as pg.PoolClient
  t.mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect)
  t.mock.method(pool, 'query', (async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT id,user_id FROM deletion_jobs')) {
      return { rows: completed ? [] : [{ id: deletionId, user_id: actorId }] }
    }
    if (sql.startsWith('UPDATE deletion_jobs SET attempts')) {
      assert.deepEqual(values, [deletionId])
      attempts += 1
    }
    return { rows: [] }
  }) as unknown as typeof pool.query)
  return {
    calls,
    get attempts() { return attempts },
    get completed() { return completed },
    get releases() { return releases },
    allowMediaUpdate() { fail = false },
  }
}

test('account deletion binds media account id and commits cleanup before reporting success', async t => {
  const state = mockCleanupDb(t)
  await maintenance()

  const statements = state.calls.map(call => call.sql)
  const mediaIndex = statements.findIndex(sql => sql.startsWith('UPDATE media_uploads'))
  const completionIndex = statements.findIndex(sql => sql.startsWith('UPDATE deletion_jobs SET completed_at'))
  assert.ok(mediaIndex > statements.indexOf('BEGIN'))
  assert.deepEqual(state.calls[mediaIndex]!.values, [actorId])
  assert.ok(completionIndex > mediaIndex)
  assert.match(statements[completionIndex]!, /last_error_code=NULL/)
  assert.ok(statements.indexOf('COMMIT') > completionIndex)
  assert.equal(statements.includes('ROLLBACK'), false)
  assert.equal(state.completed, true)
  assert.equal(state.attempts, 0)
  assert.equal(state.releases, 1)
  assert.deepEqual(state.calls[completionIndex]!.values, [deletionId])
})

test('media cleanup failure rolls back, records retry, and completes on a later sweep', async t => {
  const state = mockCleanupDb(t, true)
  await maintenance()

  const statements = state.calls.map(call => call.sql)
  assert.ok(statements.includes('BEGIN'))
  assert.ok(statements.includes('ROLLBACK'))
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(statements.some(sql => sql.startsWith('UPDATE users')), false)
  assert.equal(statements.some(sql => sql.startsWith('UPDATE deletion_jobs SET completed_at')), false)
  const retryIndex = statements.findIndex(sql => sql.startsWith('UPDATE deletion_jobs SET attempts'))
  assert.ok(retryIndex > statements.indexOf('ROLLBACK'))
  assert.match(statements[retryIndex]!, /last_error_code='CLEANUP_FAILED'/)
  assert.equal(state.completed, false)
  assert.equal(state.attempts, 1)
  assert.equal(state.releases, 1)

  state.allowMediaUpdate()
  await maintenance()
  assert.equal(state.completed, true)
  assert.equal(state.attempts, 1)
  assert.equal(state.releases, 2)
  assert.equal(state.calls.filter(call => call.sql === 'COMMIT').length, 1)
})
