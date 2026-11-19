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

test('account deletion requests cancellation without inventing provider completion, rolls back queue failure and rejects repeats', async t => {
  const jobs = ['queued', 'retry_wait', 'running', 'succeeded'].map(status => ({ status, cancelRequested: false }))
  let committed = { deleted: false, jobs, cleanup: false, audit: false }
  let staged = structuredClone(committed)
  let failQueue = true
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
      assert.match(sql, /cancel_requested_at=COALESCE/)
      assert.doesNotMatch(sql, /SET status=|completed_at=/)
      assert.deepEqual(params, [ownerId])
      for (const job of staged.jobs) if (['queued', 'retry_wait', 'running'].includes(job.status)) job.cancelRequested = true
    } else if (sql.includes("'media.job.completed'")) assert.fail('only the actual terminal transition may emit media completion')
    else if (sql.startsWith('INSERT INTO deletion_jobs')) {
      if (failQueue) throw new Error('QUEUE_FAILED')
      staged.cleanup = true
    } else if (sql.startsWith('INSERT INTO audit_logs')) staged.audit = true
    return { rows: [] }
  }
  t.mock.method(db(), 'connect', async () => ({ query, release() {} }))
  await assert.rejects(deleteUser(context), /QUEUE_FAILED/)
  assert.equal(committed.deleted, false)
  assert.equal(committed.jobs.some(job => job.cancelRequested), false)
  assert.equal(calls.at(-1), 'ROLLBACK')
  failQueue = false
  assert.equal((await deleteUser(context)).status, 200)
  assert.equal(committed.deleted, true)
  assert.deepEqual(committed.jobs.map(job => job.status), ['queued', 'retry_wait', 'running', 'succeeded'])
  assert.deepEqual(committed.jobs.map(job => job.cancelRequested), [true, true, true, false])
  assert.equal(committed.cleanup, true)
  assert.equal(committed.audit, true)
  assert.equal(calls.at(-1), 'COMMIT')
  assert.equal((await deleteUser(context)).status, 404)
})
