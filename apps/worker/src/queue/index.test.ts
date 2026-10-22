import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { redis, blockingRedis } from '../shared/infra'
import { consume, dispatchOutbox, trimGenerationStream, TRIM_GENERATION_STREAM_LUA } from './index'

test('outbox claims atomically and fences confirmation; Redis failure releases only its token', async t => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    statements.push({ sql, values })
    if (sql.startsWith('WITH ready')) return { rows: [{ id: 'e1', aggregate_id: 'j1', payload: {} }, { id: 'e2', aggregate_id: 'j2', payload: {} }] }
    return { rows: [] }
  })
  t.mock.method(redis, 'xAdd', async (_: unknown, __: unknown, fields: { eventId: string }) => {
    if (fields.eventId === 'e2') throw new Error('offline')
    return '1-0'
  })
  await dispatchOutbox()
  assert.match(statements[0].sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(statements[0].sql, /dispatch_lease_expires_at <= now\(\)/)
  assert.equal(statements.length, 3)
  const confirmed = statements.find(row => row.sql.includes('dispatched_at=now()'))!
  const released = statements.find(row => row.sql.startsWith('UPDATE') && !row.sql.includes('dispatched_at=now()'))!
  assert.deepEqual(confirmed.values, ['e1', statements[0].values[0]])
  assert.match(confirmed.sql, /dispatch_token=\$2 AND dispatch_lease_expires_at>now\(\)/)
  assert.deepEqual(released.values, ['e2', statements[0].values[0]])
})

test('consumer runs jobs concurrently, never exceeds configured capacity, and leaves failures pending', async t => {
  const stop = new AbortController()
  const acked: string[] = []
  let running = 0; let maxRunning = 0; let next = 0; let completed = 0
  const previous = process.env.WORKER_CONCURRENCY
  process.env.WORKER_CONCURRENCY = '2'
  t.after(() => { if (previous === undefined) delete process.env.WORKER_CONCURRENCY; else process.env.WORKER_CONCURRENCY = previous })
  t.mock.method(blockingRedis, 'connect', async () => {})
  t.mock.method(redis, 'xGroupCreate', async () => 'OK')
  t.mock.method(redis, 'xAutoClaim', async () => ({ messages: [] }))
  t.mock.method(redis, 'set', async () => 'OK')
  t.mock.method(redis, 'xAck', async (_: string, __: string, id: string) => { acked.push(id); return 1 })
  t.mock.method(blockingRedis, 'xReadGroup', async (_: unknown, __: unknown, ___: unknown, options: { COUNT: number }) => {
    const messages = Array.from({ length: Math.min(options.COUNT, 4 - next) }, () => {
      const id = String(++next)
      return { id, message: { jobId: id } }
    })
    if (messages.length === 0) await new Promise(resolve => setTimeout(resolve, 2))
    return [{ messages }]
  })
  let activity = 0
  await consume(async job => {
    running++; maxRunning = Math.max(running, maxRunning)
    await new Promise(resolve => setTimeout(resolve, 8))
    running--; completed++
    if (completed === 4) stop.abort()
    if (job === '2') throw new Error('DB_OFFLINE')
    return true
  }, { signal: stop.signal, onActivity: () => { activity++ } })
  assert.equal(maxRunning, 2)
  assert.equal(completed, 4)
  assert.deepEqual(acked.sort(), ['1', '3', '4'])
  assert.ok(activity > 0)
})

test('retention can be disabled and defaults to bounded seven-day atomic cleanup', async t => {
  const previous = process.env.STREAM_RETENTION_SECONDS
  t.after(() => { if (previous === undefined) delete process.env.STREAM_RETENTION_SECONDS; else process.env.STREAM_RETENTION_SECONDS = previous })
  const evaluate = t.mock.method(redis, 'eval', async () => 7)
  process.env.STREAM_RETENTION_SECONDS = '0'
  assert.equal(await trimGenerationStream(), 0)
  assert.equal(evaluate.mock.callCount(), 0)
  delete process.env.STREAM_RETENTION_SECONDS
  assert.equal(await trimGenerationStream(), 7)
  const args = evaluate.mock.calls[0].arguments as unknown as [string, { arguments: string[] }]
  assert.equal(args[0], TRIM_GENERATION_STREAM_LUA)
  assert.equal(args[1].arguments[2], '1000')
  assert.ok(Math.abs(Number(args[1].arguments[1].split('-')[0]) - (Date.now() - 604800000)) < 1000)
})
