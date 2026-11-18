import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { AGENT_MEDIA_EVENT_STREAM, AGENT_STREAM, GENERATION_STREAM, OUTBOX_EVENT_TYPES, routeOutboxEvent } from '../../apps/worker/src/queue/outbox-routing'

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
  } finally {
    assert.match(namespace, /^fixture:agent-streams:[0-9a-f-]{36}$/)
    try { if (client.isOpen) await client.del([wakeKey, mediaKey]) }
    finally { if (client.isOpen) client.destroy() }
  }
})

type StreamEntry = { id: string; message: Record<string, string> }

function readMessages(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) return []
  return (reply as Array<{ messages?: StreamEntry[] }>).flatMap(stream => stream.messages ?? [])
}
