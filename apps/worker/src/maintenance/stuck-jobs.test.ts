import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { db } from '@musecanvas/database'
import { recoverStuckJobs, STUCK_JOB_MIN_AGE_MS } from './index'

/**
 * Exercises the recovery write path with a fake SQL surface. The SQL predicate
 * itself (age + no provider_run + not cancelled) is re-checked inside the UPDATE,
 * so this test proves the delivery contract rather than re-implementing SQL.
 */
function stuckFixture(t: TestContext, options: { candidates: string[]; updated?: { attempt: number; retry_cycle: string } | null }) {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values })
    const rows = (result: Record<string, unknown>[] = []) => ({ rows: structuredClone(result), rowCount: result.length })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows()
    if (sql.startsWith('SELECT j.id FROM generation_jobs')) return rows(options.candidates.map(id => ({ id })))
    if (sql.startsWith("UPDATE generation_jobs SET status='retry_wait'")) return rows(options.updated ? [options.updated] : [])
    if (sql.startsWith('INSERT INTO outbox_events')) return rows()
    assert.fail(`Unexpected recovery SQL: ${sql}`)
  }
  t.mock.method(db(), 'query', query)
  t.mock.method(db(), 'connect', async () => ({ query, release() { /* fake connection owns nothing */ } }))
  return {
    statements,
    retries: () => statements.filter(entry => entry.sql.startsWith('INSERT INTO outbox_events')),
  }
}

test('a crashed pre-run claim is requeued with a deduplicated delivery', async t => {
  const fixture = stuckFixture(t, { candidates: ['job'], updated: { attempt: 2, retry_cycle: '2026-11-19 10:00:00.123456+00' } })

  assert.equal(await recoverStuckJobs(), 1)

  const selection = fixture.statements.find(entry => entry.sql.startsWith('SELECT j.id FROM generation_jobs'))
  assert.ok(selection)
  assert.deepEqual(selection.values, [STUCK_JOB_MIN_AGE_MS])
  assert.match(selection.sql, /NOT EXISTS \(SELECT 1 FROM provider_runs/)

  const retries = fixture.retries()
  assert.equal(retries.length, 1)
  assert.deepEqual(retries[0].values, [
    'job',
    JSON.stringify({ jobId: 'job' }),
    'generation.retry:stuck:job:2026-11-19 10:00:00.123456+00:2',
  ])
})

test('a job that gained a run before the sweep keeps running and queues nothing', async t => {
  const fixture = stuckFixture(t, { candidates: ['job'], updated: null })

  assert.equal(await recoverStuckJobs(), 0)
  assert.equal(fixture.retries().length, 0)
  assert.ok(fixture.statements.some(entry => entry.sql.startsWith("UPDATE generation_jobs SET status='retry_wait'")))
})

test('no candidates means no transaction at all', async t => {
  const fixture = stuckFixture(t, { candidates: [] })

  assert.equal(await recoverStuckJobs(), 0)
  assert.equal(fixture.retries().length, 0)
  assert.equal(fixture.statements.some(entry => entry.sql === 'BEGIN'), false)
})
