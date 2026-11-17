import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from './mock-workspace-test-loader.mjs'

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000'
const OTHER_SESSION_ID = '223e4567-e89b-12d3-a456-426614174000'
const TURN_ID = '323e4567-e89b-12d3-a456-426614174000'
const ITEM_ID = '423e4567-e89b-12d3-a456-426614174000'
const TOOL_ID = '523e4567-e89b-12d3-a456-426614174000'
const APPROVAL_ID = '623e4567-e89b-12d3-a456-426614174000'
const EVENT_ID = '723e4567-e89b-12d3-a456-426614174000'

const apiModule = loadTs(new URL('./api.ts', import.meta.url), { '@musecanvas/contracts': {} })
const endpoints = {
  agent: {
    events: (id) => `/api/agent/sessions/${encodeURIComponent(id)}/events`,
  },
}

const {
  AgentEventStreamError,
  parseAgentReplayFrame,
  parseAgentReplayStream,
  subscribeAgentEvents,
} = loadTs(new URL('./agent-events.ts', import.meta.url), {
  '@musecanvas/contracts': { API_ENDPOINTS: endpoints },
  './api': apiModule,
})

function sseStreamFromChunks(chunks, { dropAfterChunks = false } = {}) {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]))
        return
      }
      if (dropAfterChunks) {
        controller.error(new TypeError('network connection lost'))
        return
      }
      controller.close()
    },
  })
}

function makeItemEvent(cursor, sequence = '1') {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type: 'item.created',
    createdAt: '2026-11-17T10:00:00.000Z',
    cursor,
    itemSequence: sequence,
    entityRevision: '1',
    payload: {
      item: {
        id: ITEM_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        sequence,
        type: 'user_message',
        toolCallId: null,
        payload: { content: 'hello' },
        createdAt: '2026-11-17T10:00:00.000Z',
      },
    },
  }
}

test('parseAgentReplayFrame parses transport frames and all 4 durable event envelopes', () => {
  const ready = parseAgentReplayFrame(
    `id: ${SESSION_ID}:0\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', sessionId: SESSION_ID, highWater: '9007199254740993' })}`,
    SESSION_ID,
  )
  assert.equal(ready.kind, 'transport')
  assert.equal(ready.frame.type, 'ready')
  assert.equal(ready.frame.highWater, '9007199254740993')

  const heartbeat = parseAgentReplayFrame(
    `id: ${SESSION_ID}:5\r\nevent: heartbeat\r\ndata: ${JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, cursor: '5' })}`,
  )
  assert.equal(heartbeat.kind, 'transport')
  assert.equal(heartbeat.frame.cursor, '5')

  const resync = parseAgentReplayFrame(
    `id: ${SESSION_ID}:5\nevent: resync.required\ndata: ${JSON.stringify({ type: 'resync.required', sessionId: SESSION_ID, reason: 'retention' })}`,
  )
  assert.equal(resync.kind, 'transport')
  assert.equal(resync.frame.reason, 'retention')

  const envelopes = [
    makeItemEvent('1', '1'),
    {
      schemaVersion: 1,
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      type: 'tool.updated',
      createdAt: '2026-11-17T10:00:01.000Z',
      cursor: '2',
      itemSequence: null,
      entityRevision: '2',
      payload: {
        tool: { id: TOOL_ID, turnId: TURN_ID, toolName: 'generate_image', status: 'waiting_approval', revision: '2' },
      },
    },
    {
      schemaVersion: 1,
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      type: 'approval.required',
      createdAt: '2026-11-17T10:00:02.000Z',
      cursor: '3',
      itemSequence: null,
      entityRevision: '2',
      payload: {
        approval: {
          id: APPROVAL_ID,
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          toolCallId: TOOL_ID,
          argumentsHash: 'a'.repeat(64),
          modelRevision: '1',
          pricingRevision: '1',
          reservationId: TOOL_ID,
          status: 'pending',
          expiresAt: '2026-11-17T10:10:00.000Z',
          resolvedBy: null,
          resolvedAt: null,
          revision: '2',
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      type: 'turn.updated',
      createdAt: '2026-11-17T10:00:03.000Z',
      cursor: '4',
      itemSequence: null,
      entityRevision: '3',
      payload: {
        turn: {
          id: TURN_ID,
          sessionId: SESSION_ID,
          status: 'waiting_approval',
          engineVersion: 'agent-core-v1',
          revision: '3',
          inputRevision: '1',
          cancelRequestedAt: null,
          terminalAt: null,
          deadlineAt: '2026-11-17T10:05:00.000Z',
          error: null,
        },
      },
    },
  ]

  for (const env of envelopes) {
    const parsed = parseAgentReplayFrame(`id: ${SESSION_ID}:${env.cursor}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}`, SESSION_ID)
    assert.equal(parsed.kind, 'event')
    assert.equal(parsed.event.type, env.type)
    assert.equal(parsed.cursor, env.cursor)
  }
})

test('parseAgentReplayFrame rejects malformed frames, mismatched event headers, or foreign session ids', () => {
  assert.equal(parseAgentReplayFrame(': keepalive\n'), null)
  assert.equal(parseAgentReplayFrame('event: heartbeat\ndata: {bad json'), null)
  assert.equal(
    parseAgentReplayFrame(
      `id: ${SESSION_ID}:1\nevent: heartbeat\ndata: ${JSON.stringify(makeItemEvent('1'))}`,
    ),
    null,
  )
  assert.equal(
    parseAgentReplayFrame(
      `id: ${OTHER_SESSION_ID}:1\nevent: item.created\ndata: ${JSON.stringify(makeItemEvent('1'))}`,
    ),
    null,
  )
  assert.equal(
    parseAgentReplayFrame(
      `id: ${SESSION_ID}:9\nevent: item.created\ndata: ${JSON.stringify(makeItemEvent('1'))}`,
    ),
    null,
  )
  assert.equal(
    parseAgentReplayFrame(
      `id: ${SESSION_ID}:0\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', sessionId: SESSION_ID, highWater: '0' })}`,
      OTHER_SESSION_ID,
    ),
    null,
  )
})

test('parseAgentReplayStream handles split chunks cleanly and distinguishes EOF vs stream drop', async () => {
  const frame1 = `id: ${SESSION_ID}:0\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', sessionId: SESSION_ID, highWater: '1' })}\n\n`
  const frame2 = `id: ${SESSION_ID}:1\nevent: item.created\ndata: ${JSON.stringify(makeItemEvent('1'))}\n\n`
  const splitStream = sseStreamFromChunks([
    ': connected\n\n',
    frame1.slice(0, 15),
    frame1.slice(15) + frame2.slice(0, 20),
    frame2.slice(20),
  ])

  const received = []
  for await (const item of parseAgentReplayStream(splitStream, { sessionId: SESSION_ID })) {
    received.push(item)
  }
  assert.equal(received.length, 2)
  assert.equal(received[0].kind, 'transport')
  assert.equal(received[1].kind, 'event')

  const truncated = sseStreamFromChunks([`id: ${SESSION_ID}:1\nevent: item.created\ndata: {"schema`])
  await assert.rejects(async () => {
    for await (const _ of parseAgentReplayStream(truncated, { sessionId: SESSION_ID })) {
      // consume
    }
  }, (err) => err instanceof AgentEventStreamError && err.code === 'STREAM_TRUNCATED')

  const dropped = sseStreamFromChunks([frame1], { dropAfterChunks: true })
  await assert.rejects(async () => {
    for await (const _ of parseAgentReplayStream(dropped, { sessionId: SESSION_ID })) {
      // consume
    }
  }, (err) => err instanceof AgentEventStreamError && err.code === 'NETWORK_ERROR')
})

test('subscribeAgentEvents sends only ?cursor, handles HTTP errors vs clean EOF vs resync vs abort', async () => {
  const requests = []
  const streamText = [
    `id: ${SESSION_ID}:0\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', sessionId: SESSION_ID, highWater: '2' })}\n\n`,
    `id: ${SESSION_ID}:2\nevent: item.created\ndata: ${JSON.stringify(makeItemEvent('2'))}\n\n`,
    `id: ${SESSION_ID}:2\nevent: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, cursor: '2' })}\n\n`,
  ]
  const seenEvents = []
  const seenFrames = []

  const eofResult = await subscribeAgentEvents({
    sessionId: SESSION_ID,
    cursor: '1',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(sseStreamFromChunks(streamText), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    },
    onTransport: (f) => seenFrames.push(f),
    onEvent: (e) => seenEvents.push(e),
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `/api/agent/sessions/${SESSION_ID}/events?cursor=1`)
  assert.equal(requests[0].init.credentials, 'include')
  assert.equal(requests[0].init.headers.Accept, 'text/event-stream')
  assert.equal('Last-Event-ID' in requests[0].init.headers, false)
  assert.equal(eofResult.outcome, 'eof')
  assert.equal(eofResult.lastCursor, '2')
  assert.equal(seenFrames.length, 2)
  assert.equal(seenEvents.length, 1)

  for (const [status, code, message] of [
    [404, 'NOT_FOUND', '接口不存在'],
    [503, 'UNAVAILABLE', 'Agent Core 暂不可用'],
    [409, 'CURSOR_AHEAD', '游标超前'],
  ]) {
    await assert.rejects(
      subscribeAgentEvents({
        sessionId: SESSION_ID,
        cursor: '0',
        fetchImpl: async () =>
          new Response(JSON.stringify({ success: false, error: { code, message } }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
      (err) => err instanceof apiModule.ApiError && err.status === status && err.code === code && err.message === message,
    )
  }

  const resyncResult = await subscribeAgentEvents({
    sessionId: SESSION_ID,
    cursor: '0',
    source: async () =>
      new Response(
        sseStreamFromChunks([
          `id: ${SESSION_ID}:0\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', sessionId: SESSION_ID, highWater: '5' })}\n\n`,
          `id: ${SESSION_ID}:0\nevent: resync.required\ndata: ${JSON.stringify({ type: 'resync.required', sessionId: SESSION_ID, reason: 'backlog' })}\n\n`,
        ]),
        { status: 200 },
      ),
  })
  assert.equal(resyncResult.outcome, 'resync_required')
  assert.equal(resyncResult.resyncReason, 'backlog')

  await assert.rejects(
    subscribeAgentEvents({
      sessionId: SESSION_ID,
      cursor: '0',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    }),
    (err) => err instanceof AgentEventStreamError && err.code === 'NETWORK_ERROR',
  )

  const ac = new AbortController()
  ac.abort()
  const abortedResult = await subscribeAgentEvents({
    sessionId: SESSION_ID,
    cursor: '0',
    signal: ac.signal,
    fetchImpl: async () => {
      throw new Error('fetch should not run after pre-abort')
    },
  })
  assert.equal(abortedResult.outcome, 'aborted')
})
