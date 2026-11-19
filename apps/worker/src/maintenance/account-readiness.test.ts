import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import { accountCleanupReadiness } from './account-readiness'

const owner = '11111111-1111-4111-8111-111111111111'

test('account readiness distinguishes convergence, protected content and references without erasing them', async () => {
  for (const [flag, expected] of [
    ['media_wait', 'WAITING_MEDIA_SETTLEMENT'],
    ['agent_wait', 'WAITING_AGENT_SETTLEMENT'],
    ['upload_wait', 'WAITING_OBJECT_DELETION'],
    ['protected_reference', 'BLOCKED_AGENT_REFERENCE'],
    ['protected_content', 'BLOCKED_AGENT_RETENTION_POLICY'],
    ['', null],
  ] as const) {
    const calls: string[] = []
    const client = { async query(sql: string, values: unknown[]) {
      calls.push(sql)
      assert.deepEqual(values, [owner])
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: owner }] }
      if (sql.startsWith('SELECT\n')) return { rows: [{ [flag]: true }] }
      return { rows: [] }
    } } as unknown as pg.PoolClient
    assert.equal(await accountCleanupReadiness(client, owner), expected)
    assert.equal(calls.some(sql => /DELETE FROM|SET status='canceled'|UPDATE agent_definitions/.test(sql)), false)
    assert.ok(calls.some(sql => sql.includes('cancel_requested_at=COALESCE')))
    const guard = calls.find(sql => sql.startsWith('SELECT\n'))!
    assert.match(guard, /owner_id=\$1/)
    assert.match(guard, /status NOT IN \('succeeded','failed','canceled'\)/)
    assert.match(guard, /status IN \('reserved','unknown'\)/)
  }
})

test('active Agent cancellation uses bounded session-before-turn locks and a durable wake, without fabricating terminal state', async () => {
  const calls: string[] = []
  const client = { async query(sql: string, values: unknown[]) {
    calls.push(sql)
    if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: owner }] }
    if (sql.startsWith('SELECT s.id')) return { rows: [{ id: 'session' }] }
    if (sql.startsWith('UPDATE agent_turns')) return { rows: [{ id: 'turn', revision: '2' }] }
    if (sql.startsWith('INSERT INTO outbox_events')) assert.deepEqual(values[1], { schemaVersion: 1, turnId: 'turn', sessionId: 'session', revision: '2' })
    if (sql.startsWith('SELECT\n')) return { rows: [{ agent_wait: true }] }
    return { rows: [] }
  } } as unknown as pg.PoolClient
  assert.equal(await accountCleanupReadiness(client, owner), 'WAITING_AGENT_SETTLEMENT')
  const lock = calls.find(sql => sql.startsWith('SELECT s.id'))!
  assert.match(lock, /LIMIT 25 FOR UPDATE OF s SKIP LOCKED/)
  assert.ok(calls.findIndex(sql => sql.startsWith('UPDATE agent_turns')) > calls.indexOf(lock))
  assert.ok(calls.some(sql => sql.includes("VALUES('agent.turn.wake'")))
  assert.equal(calls.some(sql => /terminal_at=|status='cancelled'/.test(sql)), false)
})

test('an account not marked for deletion cannot enter byte cleanup', async () => {
  let queries = 0
  const client = { async query() { queries += 1; return { rows: [] } } } as unknown as pg.PoolClient
  assert.equal(await accountCleanupReadiness(client, owner), 'BLOCKED_ACCOUNT_STATE')
  assert.equal(queries, 1)
})
