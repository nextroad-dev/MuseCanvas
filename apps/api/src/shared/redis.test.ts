import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import { createClient } from 'redis'
import { createRedisAccess, limited } from './redis'

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    isReady: false, isOpen: true, destroyed: 0, connects: 0,
    async connect() { this.connects++; await new Promise(resolve => setTimeout(resolve, 5)); this.isReady = true },
    destroy() { this.destroyed++; this.isOpen = false; this.isReady = false },
    async ping() { return 'PONG' },
  })
  return { client, factory: () => client as unknown as ReturnType<typeof createClient> }
}

test('concurrent Redis callers share connection setup and have an error listener before connect', async () => {
  const { client, factory } = fixture()
  const log = mock.method(console, 'error', () => {})
  try {
    const access = createRedisAccess(factory)
    const values = await Promise.all(Array.from({ length: 40 }, () => access.run(c => c.ping())))
    assert.equal(client.connects, 1)
    assert.equal(values.length, 40)
    assert.equal(client.listenerCount('error'), 1)
    client.emit('error', new Error('private redis URL or password'))
    client.emit('error', new Error('private redis URL or password'))
    assert.equal(log.mock.callCount(), 1)
    assert.deepEqual(log.mock.calls[0]!.arguments, ['redis connection error', { code: 'REDIS_CONNECTION_ERROR' }])
  } finally { log.mock.restore() }
})

test('connection and command stalls reject within the caller budget and discard the socket', async () => {
  const { client, factory } = fixture()
  const access = createRedisAccess(factory, 20)
  await assert.rejects(access.run(() => new Promise<never>(() => {})), /REDIS_TIMEOUT/)
  assert.equal(client.destroyed, 1)
  await assert.rejects(access.run(c => c.ping()), /REDIS_UNAVAILABLE/)

  const stalled = fixture()
  stalled.client.connect = () => new Promise<never>(() => {})
  const previous = process.env.REDIS_CONNECT_TIMEOUT_MS
  process.env.REDIS_CONNECT_TIMEOUT_MS = '15'
  try {
    await assert.rejects(createRedisAccess(stalled.factory, 50).run(c => c.ping()), /REDIS_TIMEOUT/)
    assert.equal(stalled.client.destroyed, 1)
  } finally {
    if (previous === undefined) delete process.env.REDIS_CONNECT_TIMEOUT_MS
    else process.env.REDIS_CONNECT_TIMEOUT_MS = previous
  }
})

test('Redis outage falls back to an enforced per-process rate budget', async () => {
  const saved = process.env.REDIS_URL
  process.env.REDIS_URL = 'redis://127.0.0.1:1'
  const log = mock.method(console, 'error', () => {})
  try {
    const key = `synthetic-outage-${Date.now()}`
    assert.equal(await limited(key, 2, 60), false)
    assert.equal(await limited(key, 2, 60), false)
    assert.equal(await limited(key, 2, 60), true)
  } finally {
    log.mock.restore()
    if (saved === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = saved
  }
})

test('a total deadline expiring during shared connect never runs a late consuming command', async () => {
  const { client, factory } = fixture()
  let finishConnect!: () => void
  const gate = new Promise<void>(resolve => { finishConnect = resolve })
  client.connect = async () => { await gate; client.isReady = true }
  const access = createRedisAccess(factory, 10)
  let consumed = 0
  await assert.rejects(access.run(async () => { consumed++; return 'token' }), /REDIS_TIMEOUT/)
  finishConnect()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(consumed, 0)
  assert.equal(await access.run(c => c.ping()), 'PONG', 'other callers can use the completed shared connection')
})
