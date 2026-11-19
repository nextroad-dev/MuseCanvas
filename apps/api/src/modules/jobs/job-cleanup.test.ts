import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { deleteJobWithAssets } from './job-cleanup'

test('job privacy deletion commits media terminal event with deletion, preserves running cancel intent, and replays without a new event', async t => {
  for (const initial of ['queued', 'retry_wait', 'running', 'failed', 'succeeded', 'canceled']) {
    let committed = { status: initial, deleted: false, events: 0, cancelIntents: 0, deletedAssets: false }
    let staged = structuredClone(committed)
    let failOutbox = true
    const calls: string[] = []
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push(sql)
      if (sql === 'BEGIN') staged = structuredClone(committed)
      else if (sql === 'COMMIT') committed = structuredClone(staged)
      else if (sql.startsWith('SELECT id,prompt_optimization_id')) {
        assert.deepEqual(params, ['job', 'owner'])
        return { rows: [{ id: 'job', deleted_at: staged.deleted ? 'deleted' : null, status: staged.status, attempt: 1 }] }
      } else if (sql.startsWith('UPDATE generation_jobs SET deleted_at')) {
        staged.deleted = true
        if (['queued', 'retry_wait', 'running'].includes(staged.status)) staged.status = 'canceled'
      } else if (sql.includes("SELECT 'media.job.completed'")) {
        assert.equal(staged.deleted, true, 'completion must survive a soft-deleted job')
        assert.equal(staged.status, 'canceled')
        assert.doesNotMatch(sql, /deleted_at IS NULL/)
        if (failOutbox) throw new Error('OUTBOX_FAILED')
        staged.events++
      } else if (sql.includes("VALUES('generation.cancel.requested'")) staged.cancelIntents++
      else if (sql.startsWith('UPDATE assets SET')) staged.deletedAssets = true
      return { rows: [] }
    }
    const connection = t.mock.method(db(), 'connect', async () => ({ query, release() {} }))
    const active = ['queued', 'retry_wait', 'running'].includes(initial)
    if (active) {
      await assert.rejects(deleteJobWithAssets('owner', 'job'), /OUTBOX_FAILED/)
      assert.deepEqual(committed, { status: initial, deleted: false, events: 0, cancelIntents: 0, deletedAssets: false })
      assert.equal(calls.at(-1), 'ROLLBACK')
    }
    failOutbox = false
    assert.equal(await deleteJobWithAssets('owner', 'job'), true)
    assert.equal(committed.deleted, true)
    assert.equal(committed.deletedAssets, true)
    assert.equal(committed.status, active ? 'canceled' : initial)
    assert.equal(committed.events, active ? 1 : 0)
    assert.equal(committed.cancelIntents, initial === 'running' ? 1 : 0)
    assert.equal(calls.at(-1), 'COMMIT')
    assert.equal(await deleteJobWithAssets('owner', 'job'), true)
    assert.equal(committed.events, active ? 1 : 0)
    assert.equal(committed.cancelIntents, initial === 'running' ? 1 : 0)
    if (initial === 'running') assert.ok(calls.some(sql => sql.startsWith('UPDATE provider_runs')))
    connection.mock.restore()
  }
})

test('missing job deletion returns false without media effects', async t => {
  const calls: string[] = []
  t.mock.method(db(), 'connect', async () => ({ async query(sql: string) { calls.push(sql); return { rows: [] } }, release() {} }))
  assert.equal(await deleteJobWithAssets('owner', 'missing'), false)
  assert.deepEqual(calls.filter(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')), [])
})
