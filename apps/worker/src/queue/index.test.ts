import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { redis, blockingRedis } from '../shared/infra'
import { consume, dispatchOutbox, trimGenerationStream, TRIM_GENERATION_STREAM_LUA } from './index'

test('outbox claims atomically and fences confirmation; Redis failure releases only its token', async t => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    statements.push({ sql, values })
    if (sql.startsWith('WITH ready')) return { rows: [{ id: 'e1', aggregate_id: 'j1', event_type: 'generation.requested', payload: {} }, { id: 'e2', aggregate_id: 'j2', event_type: 'generation.retry', payload: {} }] }
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

test('outbox dispatch quarantines unknown types without publishing and releases failed Redis publishes', async t => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    statements.push({ sql, values })
    if (sql.startsWith('WITH ready')) return { rows: [
      { id: 'unknown', aggregate_id: 'x', event_type: 'not.real', payload: { secret: 'not-logged' } },
      { id: 'retry', aggregate_id: 'j2', event_type: 'generation.retry', payload: { jobId: 'j2' } },
    ] }
    return { rows: [] }
  })
  const published: string[] = []
  t.mock.method(redis, 'xAdd', async (stream: string, _: unknown, fields: { eventId: string }) => {
    published.push(`${stream}:${fields.eventId}`)
    throw new Error('offline')
  })
  await dispatchOutbox()
  assert.match(statements[0].sql, /event_type,e\.payload/)
  assert.match(statements[0].sql, /quarantined_at IS NULL/)
  assert.deepEqual(published, ['muse:generation:retry'])
  const quarantined = statements.find(row => row.sql.includes('quarantined_at=now()'))!
  assert.match(quarantined.sql, /dispatch_token=\$2 AND dispatch_lease_expires_at>now\(\)/)
  assert.deepEqual(quarantined.values.slice(1), [statements[0].values[0], 'UNKNOWN_EVENT_TYPE'])
  const released = statements.find(row => row.sql.startsWith('UPDATE') && row.sql.includes('dispatch_token=NULL') && !row.sql.includes('quarantined_at=now()'))!
  assert.deepEqual(released.values, ['retry', statements[0].values[0]])
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

type FakeOutboxRow = {
  id: string
  aggregate_id: string
  event_type: string
  payload: unknown
  token: string | null
  leaseUntil: number
  dispatched: boolean
  quarantined: boolean
}
function fakeOutboxRow(id: string, event_type = 'generation.requested'): FakeOutboxRow {
  return { id, aggregate_id: `job-${id}`, event_type, payload: {}, token: null, leaseUntil: 0, dispatched: false, quarantined: false }
}
function fakeOutbox(rows: FakeOutboxRow[]) {
  let clock = 1
  let failNextConfirmation = false
  return {
    rows,
    advance: () => { clock += 121 },
    failConfirmation: () => { failNextConfirmation = true },
    query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('WITH ready')) {
        // Assert the actual SQL asks for the same admission conditions modeled here.
        assert.match(sql, /dispatched_at IS NULL AND quarantined_at IS NULL/)
        assert.match(sql, /dispatch_lease_expires_at <= now\(\)/)
        const claimed = rows.filter(row => !row.dispatched && !row.quarantined && row.leaseUntil <= clock).slice(0, 100)
        for (const row of claimed) { row.token = values[0] as string; row.leaseUntil = clock + 120 }
        return { rows: claimed.map(row => ({ id: row.id, aggregate_id: row.aggregate_id, event_type: row.event_type, payload: row.payload })) }
      }
      const row = rows.find(row => row.id === values[0])!
      if (sql.includes('dispatched_at=now()') && failNextConfirmation) { failNextConfirmation = false; throw new Error('confirmation unavailable') }
      if (row.token !== values[1]) return { rows: [], rowCount: 0 }
      if ((sql.includes('dispatched_at=now()') || sql.includes('quarantined_at=now()')) && row.leaseUntil <= clock) return { rows: [], rowCount: 0 }
      if (sql.includes('dispatched_at=now()')) row.dispatched = true
      if (sql.includes('quarantined_at=now()')) row.quarantined = true
      row.token = null; row.leaseUntil = 0
      return { rows: [], rowCount: 1 }
    },
  }
}

test('quarantine is durable and a batch of unknown events cannot starve the next valid command', async t => {
  const fake = fakeOutbox([...Array.from({ length: 100 }, (_, i) => fakeOutboxRow(`unknown-${i}`, 'unknown.type')), fakeOutboxRow('valid')])
  t.mock.method(db(), 'query', fake.query)
  t.mock.method(console, 'warn', () => {})
  const add = t.mock.method(redis, 'xAdd', async () => '1-0')
  await dispatchOutbox()
  assert.equal(add.mock.callCount(), 0)
  assert.equal(fake.rows.filter(row => row.quarantined).length, 100)
  await dispatchOutbox()
  assert.equal(add.mock.callCount(), 1)
  assert.equal(fake.rows.at(-1)!.dispatched, true)
})

test('publish then confirmation failure retries with the same eventId for at-least-once delivery', async t => {
  const fake = fakeOutbox([fakeOutboxRow('recover')])
  t.mock.method(db(), 'query', fake.query)
  const published: string[] = []
  t.mock.method(redis, 'xAdd', async (_: unknown, __: unknown, fields: Record<string, string>) => { published.push(fields.eventId); return '1-0' })
  fake.failConfirmation()
  await dispatchOutbox()
  assert.equal(fake.rows[0].dispatched, false)
  assert.equal(fake.rows[0].token, null)
  await dispatchOutbox()
  assert.deepEqual(published, ['recover', 'recover'])
  assert.equal(fake.rows[0].dispatched, true)
})

test('expired publish cannot confirm or release a newer claim; lease recovery permits redelivery', async t => {
  const fake = fakeOutbox([fakeOutboxRow('stale')])
  t.mock.method(db(), 'query', fake.query)
  let first = true
  t.mock.method(redis, 'xAdd', async () => {
    if (first) { first = false; fake.advance(); fake.rows[0].token = 'new-owner'; fake.rows[0].leaseUntil += 121 }
    return '1-0'
  })
  await dispatchOutbox()
  assert.equal(fake.rows[0].dispatched, false)
  assert.equal(fake.rows[0].token, 'new-owner')
  await dispatchOutbox()
  assert.equal(fake.rows[0].token, 'new-owner')
  fake.advance()
  await dispatchOutbox()
  assert.equal(fake.rows[0].dispatched, true)
})

test('stale quarantine cannot clear a newer owner token or mark the event dispatched', async t => {
  const fake = fakeOutbox([fakeOutboxRow('stale-unknown', 'unknown.type')])
  t.mock.method(console, 'warn', () => {})
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('quarantined_at=now()')) { fake.advance(); fake.rows[0].token = 'new-owner'; fake.rows[0].leaseUntil += 121 }
    return fake.query(sql, values)
  })
  const add = t.mock.method(redis, 'xAdd', async () => '1-0')
  await dispatchOutbox()
  assert.equal(add.mock.callCount(), 0)
  assert.equal(fake.rows[0].quarantined, false)
  assert.equal(fake.rows[0].dispatched, false)
  assert.equal(fake.rows[0].token, 'new-owner')
})
