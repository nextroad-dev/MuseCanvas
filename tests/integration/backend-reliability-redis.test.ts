import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const url = process.env.MUSECANVAS_OPTIMIZATION_REDIS_URL
const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url))

test('isolated Redis: retention preserves pending, unread, young and unknown-group entries', { skip: !url, timeout: 20_000 }, async () => {
  const target = new URL(url!)
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.pathname, '/15', 'only the synthetic fixture database is allowed')
  const previousRedis = process.env.REDIS_URL
  process.env.REDIS_URL = url
  const { TRIM_GENERATION_STREAM_LUA } = await import('../../apps/worker/src/queue/index')
  const { createClient } = require('redis') as typeof import('redis')
  const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } })
  client.on('error', () => {})
  const key = `fixture:optimization:${randomUUID()}`
  const trim = (cutoff = '5000-0', batch = '1000') => client.eval(TRIM_GENERATION_STREAM_LUA, { keys: [key], arguments: ['workers', cutoff, batch] })
  await client.connect()
  try {
    for (const id of ['1000-0', '1000-1', '1001-0', '1002-0']) await client.xAdd(key, id, { fixture: '1' })
    await client.xGroupCreate(key, 'workers', '0')
    await client.xReadGroup('workers', 'owner', { key, id: '>' }, { COUNT: 3 })
    await client.xAck(key, 'workers', '1000-0')
    assert.equal(await trim(), 1)
    assert.deepEqual((await client.xRange(key, '-', '+')).map(row => row.id), ['1000-1', '1001-0', '1002-0'])
    assert.equal((await client.xPending(key, 'workers')).pending, 2)
    await client.xAck(key, 'workers', ['1000-1', '1001-0'])
    assert.equal(await trim(), 1)
    assert.deepEqual((await client.xRange(key, '-', '+')).map(row => row.id), ['1001-0', '1002-0'])
    await client.xReadGroup('workers', 'owner', { key, id: '>' }, { COUNT: 1 })
    await client.xAck(key, 'workers', '1002-0')
    await client.xAdd(key, '5001-0', { fixture: 'young' })
    await client.xReadGroup('workers', 'owner', { key, id: '>' }, { COUNT: 1 })
    await client.xAck(key, 'workers', '5001-0')
    assert.equal(await trim('5000-0', '1'), 1, 'each cleanup is bounded')
    await client.xGroupCreate(key, 'unknown-observer', '0')
    assert.equal(await trim(), 0, 'a second group disables cleanup atomically')
    await client.xGroupDestroy(key, 'workers')
    assert.equal(await trim(), 0, 'an unknown sole group is also protected')
    assert.ok((await client.xRange(key, '-', '+')).some(row => row.id === '5001-0'))
  } finally {
    assert.match(key, /^fixture:optimization:/)
    try { await client.del(key) }
    finally {
      client.destroy()
      if (previousRedis === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = previousRedis
    }
  }
})
