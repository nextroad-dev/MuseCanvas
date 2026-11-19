import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { AGENT_MEDIA_EVENT_STREAM, AGENT_STREAM, AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP, GENERATION_STREAM, OUTBOX_EVENT_TYPES, routeOutboxEvent } from '../../apps/worker/src/queue/outbox-routing'
import { TRIM_AGENT_STREAM_LUA } from '../../apps/worker/src/queue/stream-retention'

const url = process.env.MUSECANVAS_AGENT_STREAMS_REDIS_URL

// Source/typecheck only in this fixture lane: DO NOT execute without explicit
// authorization. Runtime use requires this dedicated loopback fixture database.
// Never load .env or inherit REDIS_URL/DATABASE_URL, and never publish to or
// delete the production stream keys; every key below is a unique fixture name.
test('isolated Redis: Agent wake/media route contract, independent groups and replay semantics', { skip: !url, timeout: 20_000 }, async () => {
  const target = new URL(url!)
  assert.equal(target.protocol, 'redis:')
  assert.equal(target.hostname, '127.0.0.1', 'fixtures are loopback-only')
  assert.equal(target.pathname, '/15', 'only the synthetic fixture database is allowed')
  const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url))
  const { createClient } = require('redis') as typeof import('redis')
  const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } })
  client.on('error', () => {})
  const namespace = `fixture:agent-streams:${randomUUID()}`
  const wakeKey = `${namespace}:wake`
  const mediaKey = `${namespace}:media-events`
  const retentionKeys: string[] = []
  try {
    await client.connect()
    const sessionId = randomUUID()
    const turnId = randomUUID()
    const wakeEventId = randomUUID()
    const wakeRoute = routeOutboxEvent({
      id: wakeEventId,
      aggregate_id: turnId,
      event_type: OUTBOX_EVENT_TYPES.agentTurnWake,
      payload: { schemaVersion: 1, sessionId, turnId, revision: '2' },
    })
    const mediaEventId = randomUUID()
    const jobId = randomUUID()
    const mediaRoute = routeOutboxEvent({
      id: mediaEventId,
      aggregate_id: jobId,
      event_type: OUTBOX_EVENT_TYPES.mediaJobCompleted,
      payload: { schemaVersion: 1, jobId },
    })
    assert.equal(wakeRoute.kind, 'publish')
    assert.equal(mediaRoute.kind, 'publish')
    if (wakeRoute.kind !== 'publish' || mediaRoute.kind !== 'publish') assert.fail('agent routes must publish')
    assert.equal(wakeRoute.stream, AGENT_STREAM)
    assert.equal(mediaRoute.stream, AGENT_MEDIA_EVENT_STREAM)
    assert.deepEqual(wakeRoute.fields, { eventId: wakeEventId, aggregateId: turnId, schemaVersion: '1', sessionId, turnId, revision: '2' })
    assert.deepEqual(mediaRoute.fields, { eventId: mediaEventId, aggregateId: jobId, schemaVersion: '1', jobId })
    assert.notEqual(AGENT_STREAM, GENERATION_STREAM)
    assert.notEqual(AGENT_MEDIA_EVENT_STREAM, GENERATION_STREAM)
    assert.notEqual(AGENT_STREAM, AGENT_MEDIA_EVENT_STREAM)
    assert.equal(routeOutboxEvent({ id: randomUUID(), aggregate_id: turnId, event_type: OUTBOX_EVENT_TYPES.agentTurnWake, payload: { schemaVersion: 2, sessionId, turnId, revision: '2' } }).kind, 'quarantine')
    assert.equal(routeOutboxEvent({ id: randomUUID(), aggregate_id: turnId, event_type: OUTBOX_EVENT_TYPES.agentTurnWake, payload: { schemaVersion: 1, sessionId, turnId, revision: '0' } }).kind, 'quarantine')
    assert.equal(routeOutboxEvent({ id: randomUUID(), aggregate_id: jobId, event_type: OUTBOX_EVENT_TYPES.mediaJobCompleted, payload: { schemaVersion: 1, jobId: '' } }).kind, 'quarantine')
    assert.equal(routeOutboxEvent({ id: randomUUID(), aggregate_id: jobId, event_type: OUTBOX_EVENT_TYPES.mediaJobCompleted, payload: { schemaVersion: 2, jobId } }).kind, 'quarantine')

    // Duplicate event delivery is two stream entries with the same eventId. Redis
    // cannot dedupe facts; the durable agent_consumed_events marker must.
    const firstId = await client.xAdd(wakeKey, '*', wakeRoute.fields)
    const secondId = await client.xAdd(wakeKey, '*', wakeRoute.fields)
    assert.notEqual(firstId, secondId)
    const wakeEntries = await client.xRange(wakeKey, '-', '+')
    assert.equal(wakeEntries.length, 2)
    assert.deepEqual(wakeEntries.map(entry => entry.message.eventId), [wakeEventId, wakeEventId])
    await client.xAdd(mediaKey, '*', mediaRoute.fields)

    // Fixture-local group names. The production Agent/media group names are not
    // assumed here; this only proves independent-group and ACK semantics.
    const agentGroup = 'agent-workers'
    const mediaGroup = 'workers'
    await client.xGroupCreate(wakeKey, agentGroup, '0')
    await client.xGroupCreate(wakeKey, mediaGroup, '0')
    const agentRead = readMessages(await client.xReadGroup(agentGroup, 'agent-a', { key: wakeKey, id: '>' }, { COUNT: 10 }))
    const mediaRead = readMessages(await client.xReadGroup(mediaGroup, 'media-a', { key: wakeKey, id: '>' }, { COUNT: 10 }))
    assert.equal(agentRead.length, 2)
    assert.equal(mediaRead.length, 2)
    assert.deepEqual(agentRead.map(entry => entry.message.eventId), [wakeEventId, wakeEventId])
    await client.xAck(wakeKey, agentGroup, firstId)
    assert.equal((await client.xPending(wakeKey, agentGroup)).pending, 1)
    assert.equal((await client.xPending(wakeKey, mediaGroup)).pending, 2)

    // A replacement Agent consumer can reclaim an unacknowledged entry without
    // touching the media group or the stream's duplicate entries.
    const reclaimed = await client.xClaimJustId(wakeKey, agentGroup, 'agent-b', 0, [secondId])
    assert.deepEqual(reclaimed, [secondId])
    await client.xAck(wakeKey, agentGroup, secondId)
    assert.equal((await client.xPending(wakeKey, agentGroup)).pending, 0)
    assert.equal((await client.xPending(wakeKey, mediaGroup)).pending, 2)

    // Media facts stay in the media stream and are never copied into the Agent
    // wake stream or the generation stream constant.
    assert.equal((await client.xRange(wakeKey, '-', '+')).length, 2)
    assert.equal((await client.xRange(mediaKey, '-', '+')).length, 1)
    assert.equal((await client.xRange(mediaKey, '-', '+'))[0]!.message.jobId, jobId)
    assert.notEqual(wakeRoute.stream, mediaRoute.stream)

    // Each guard must dominate a separate call; a small batch or the last-delivered
    // cursor must not accidentally hide a missing pending/age/unread boundary.
    for (const group of [AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP]) {
      const make = async (name: string, ids: string[]) => {
        const key = `${namespace}:retention:${group}:${name}`
        retentionKeys.push(key)
        for (const id of ids) await client.xAdd(key, id, { fixture: id })
        await client.xGroupCreate(key, group, '0')
        return key
      }
      const trim = (key: string, batch = 100) => client.eval(TRIM_AGENT_STREAM_LUA, { keys: [key], arguments: [group, '60', String(batch)] }) as Promise<unknown[]>
      const remaining = async (key: string) => (await client.xRange(key, '-', '+')).map(row => row.id)

      // Pending and last-delivered IDs differ by one beyond Lua double precision.
      const pendingIds = ['1-9007199254740991', '1-9007199254740992', '1-9007199254740993', '2-0']
      const pendingKey = await make('pending-precision', pendingIds)
      await client.xReadGroup(group, 'fixture-a', { key: pendingKey, id: '>' }, { COUNT: 3 })
      await client.xAck(pendingKey, group, [pendingIds[0]!, pendingIds[2]!])
      assert.equal((await trim(pendingKey))[0], 1, 'pending boundary dominates a large batch and the later delivered cursor')
      assert.deepEqual(await remaining(pendingKey), pendingIds.slice(1))
      assert.equal((await client.xPending(pendingKey, group)).pending, 1)
      const reclaimed = await client.xAutoClaim(pendingKey, group, 'fixture-b', 0, '0-0', { COUNT: 10 })
      assert.deepEqual(reclaimed.messages.filter(Boolean).map(row => row!.id), [pendingIds[1]])
      assert.equal(reclaimed.messages[0]?.message.fixture, pendingIds[1], 'pending payload remains reclaimable after trim')
      await client.xAck(pendingKey, group, pendingIds[1]!)
      assert.equal((await trim(pendingKey))[0], 1)
      assert.deepEqual(await remaining(pendingKey), pendingIds.slice(2))

      const unreadIds = ['10-0', '20-0', '30-0', '40-0']
      const unreadKey = await make('unread', unreadIds)
      await client.xReadGroup(group, 'fixture-a', { key: unreadKey, id: '>' }, { COUNT: 2 })
      await client.xAck(unreadKey, group, unreadIds.slice(0, 2))
      assert.equal((await trim(unreadKey))[0], 1, 'all old entries are ACKed or unread; delivered cursor alone must protect unread entries')
      assert.deepEqual(await remaining(unreadKey), unreadIds.slice(1))
      const unread = readMessages(await client.xReadGroup(group, 'fixture-a', { key: unreadKey, id: '>' }, { COUNT: 10 }))
      assert.deepEqual(unread.map(row => row.id), unreadIds.slice(2))
      await client.xAck(unreadKey, group, unreadIds.slice(2))

      const time = await client.sendCommand(['TIME']) as string[]
      const youngTime = Number(time[0]) * 1000
      const youngIds = ['1-0', `${youngTime}-0`, `${youngTime}-1`]
      const youngKey = await make('young', youngIds)
      await client.xReadGroup(group, 'fixture-a', { key: youngKey, id: '>' }, { COUNT: 10 })
      await client.xAck(youngKey, group, youngIds)
      assert.equal((await trim(youngKey))[0], 1, 'age cutoff protects a young ACKed entry strictly before last-delivered-id')
      assert.deepEqual(await remaining(youngKey), youngIds.slice(1))
      assert.equal((await trim(youngKey))[0], 0)
      assert.deepEqual(await remaining(youngKey), youngIds.slice(1))

      const batchIds = ['1-0', '2-0', '3-0', '4-0', '5-0']
      const batchKey = await make('batch', batchIds)
      await client.xReadGroup(group, 'fixture-a', { key: batchKey, id: '>' }, { COUNT: 10 })
      await client.xAck(batchKey, group, batchIds)
      for (let i = 1; i < batchIds.length; i += 1) {
        assert.equal((await trim(batchKey, 1))[0], 1, 'one eligible entry per bounded sweep')
        assert.deepEqual(await remaining(batchKey), batchIds.slice(i))
      }
      assert.equal((await trim(batchKey, 1))[0], 0)
      await client.xGroupCreate(batchKey, 'unknown-group', '0')
      assert.equal((await trim(batchKey))[1], 'unexpected-group')
      assert.deepEqual(await remaining(batchKey), batchIds.slice(-1))

      const zeroKey = await make('zero-cursor', ['1-0'])
      assert.equal((await trim(zeroKey))[1], 'no-eligible', 'never-delivered group must not issue XRANGE with exclusive 0-0')
      assert.deepEqual(await remaining(zeroKey), ['1-0'])
      const emptyKey = `${zeroKey}:missing`
      assert.equal((await trim(emptyKey))[1], 'missing-key')
      const noGroup = `${zeroKey}:no-group`
      retentionKeys.push(noGroup)
      await client.xAdd(noGroup, '1-0', { fixture: 'orphan' })
      assert.equal((await trim(noGroup))[1], 'no-group')
      await client.xGroupCreate(noGroup, 'wrong-group', '0')
      assert.equal((await trim(noGroup))[1], 'unexpected-group')
    }
  } finally {
    assert.match(namespace, /^fixture:agent-streams:[0-9a-f-]{36}$/)
    try { if (client.isOpen) await client.del([wakeKey, mediaKey, ...retentionKeys]) }
    finally { if (client.isOpen) client.destroy() }
  }
})

type StreamEntry = { id: string; message: Record<string, string> }

function readMessages(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) return []
  return (reply as Array<{ messages?: StreamEntry[] }>).flatMap(stream => stream.messages ?? [])
}
