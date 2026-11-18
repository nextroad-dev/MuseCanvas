import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { db } from '@musecanvas/database'
import type { AuthedContext } from '../../router/types'
import { deleteUser } from './users'

const ownerId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const context: AuthedContext = {
  request: new NextRequest(`https://example.invalid/api/admin/users/${ownerId}`),
  actor: { id: actorId, role: 'admin', status: 'active', email: 'admin@example.invalid', createdAt: '' },
  path: `admin/users/${ownerId}`, params: { id: ownerId }, json: async () => ({}),
}

test('account deletion emits one media event per actual bulk terminal transition, atomically rolls back failure, and ignores repeat deletion', async t => {
  const jobs = [{ id: 'queued-job', status: 'queued' }, { id: 'retry-job', status: 'retry_wait' }, { id: 'running-job', status: 'running' }, { id: 'terminal-job', status: 'succeeded' }]
  let committed = { deleted: false, jobs, events: [] as string[], cleanup: false, audit: false }
  let staged = structuredClone(committed)
  let failOnSecond = true
  const calls: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push(sql)
    if (sql === 'BEGIN') staged = structuredClone(committed)
    else if (sql === 'COMMIT') committed = structuredClone(staged)
    else if (sql.startsWith('UPDATE users SET deleted_at')) {
      assert.deepEqual(params, [ownerId])
      if (staged.deleted) return { rows: [] }
      staged.deleted = true
      return { rows: [{ id: ownerId }] }
    } else if (sql.startsWith('UPDATE generation_jobs SET')) {
      assert.match(sql, /status IN\('queued','retry_wait','running'\) RETURNING id/)
      assert.deepEqual(params, [ownerId])
      const changed = staged.jobs.filter(j => ['queued', 'retry_wait', 'running'].includes(j.status))
      for (const j of changed) j.status = 'canceled'
      return { rows: changed.map(j => ({ id: j.id })) }
    } else if (sql.includes("SELECT 'media.job.completed'")) {
      assert.doesNotMatch(sql, /deleted_at IS NULL/)
      const job = staged.jobs.find(j => j.id === params[0])!
      assert.equal(job.status, 'canceled')
      if (failOnSecond && staged.events.length === 1) throw new Error('OUTBOX_FAILED')
      staged.events.push(String(params[0]))
    } else if (sql.startsWith('INSERT INTO deletion_jobs')) staged.cleanup = true
    else if (sql.startsWith('INSERT INTO audit_logs')) staged.audit = true
    return { rows: [] }
  }
  t.mock.method(db(), 'connect', async () => ({ query, release() {} }))
  await assert.rejects(deleteUser(context), /OUTBOX_FAILED/)
  assert.equal(committed.deleted, false)
  assert.deepEqual(committed.jobs.map(j => j.status), ['queued', 'retry_wait', 'running', 'succeeded'])
  assert.deepEqual(committed.events, [])
  assert.equal(calls.at(-1), 'ROLLBACK')
  failOnSecond = false
  assert.equal((await deleteUser(context)).status, 200)
  assert.equal(committed.deleted, true)
  assert.deepEqual(committed.events, ['queued-job', 'retry-job', 'running-job'])
  assert.equal(committed.cleanup, true)
  assert.equal(committed.audit, true)
  assert.equal(committed.jobs.at(-1)!.status, 'succeeded')
  assert.equal(calls.at(-1), 'COMMIT')
  assert.equal((await deleteUser(context)).status, 404)
  assert.equal(committed.events.length, 3)
})
