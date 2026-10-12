import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AgentStreamDisconnectedError,
  AgentStreamHttpError,
  parseAgentEventStream,
  streamAgentEvents,
} from './agent-stream.ts'

const encoder = new TextEncoder()

function byteStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

function frame(type, event) {
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
}

function doneFrame(turnId = 't1') {
  return frame('done', {
    type: 'done',
    turnId,
    eventId: 'e-done',
    message: { id: 'm1', seq: 1, role: 'assistant', content: 'ok', createdAt: 'now' },
    usage: { inputTokens: 1, outputTokens: 1 },
    requireConfirmation: true,
    autoContinuationCount: 0,
  })
}

async function collect(generator) {
  const events = []
  for await (const event of generator) events.push(event)
  return events
}

test('split chunks reassemble multi-byte UTF-8 without replacement characters', async () => {
  const event = { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: '你好，世界 · café' }
  const bytes = encoder.encode(frame('text_delta', event) + doneFrame())
  // One byte per enqueue guarantees every multi-byte code point is split.
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))
  const events = await collect(parseAgentEventStream(byteStream(chunks)))
  assert.deepEqual(events.map((entry) => entry.type), ['text_delta', 'done'])
  assert.equal(events[0].delta, '你好，世界 · café')
  assert.ok(!events[0].delta.includes('\uFFFD'))
})

test('multi-line data fields are joined with a newline', async () => {
  const event = { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'first\nsecond' }
  // Pretty-printed JSON legitimately contains newlines between tokens; SSE splits
  // those across one `data:` line each, and the parser must rejoin them verbatim.
  const lines = JSON.stringify(event, null, 2).split('\n')
  const input = `event: text_delta\n${lines.map((line) => `data: ${line}`).join('\n')}\n\n` + doneFrame()
  const events = await collect(parseAgentEventStream(byteStream([input])))
  assert.equal(events[0].type, 'text_delta')
  assert.equal(events[0].delta, 'first\nsecond')
})

test('CRLF framing and comment/heartbeat frames parse, unknown fields are ignored', async () => {
  const event = { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'ok', futureField: { unknown: true } }
  const input = `: connected\r\n: heartbeat\r\nid: 1234\r\nevent: text_delta\r\ndata: ${JSON.stringify(event)}\r\n\r\n` + doneFrame()
  const events = await collect(parseAgentEventStream(byteStream([input])))
  assert.equal(events[0].type, 'text_delta')
  assert.equal(events[0].delta, 'ok')
})

test('an unknown event type or mismatched event name is dropped without failing the stream', async () => {
  const known = { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'kept' }
  const input = frame('mystery', { type: 'mystery', turnId: 't1', eventId: 'e0' })
    + `event: text_delta\ndata: ${JSON.stringify({ ...known, type: 'done' })}\n\n`
    + frame('text_delta', known)
    + frame('done', { ...known, type: 'done', message: { id: 'm', seq: 1, role: 'assistant', content: 'kept', createdAt: 'now' }, usage: { inputTokens: 1, outputTokens: 1 }, requireConfirmation: true, autoContinuationCount: 0 })
  const events = await collect(parseAgentEventStream(byteStream([input])))
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'done'])
})

test('HTTP JSON error envelope becomes an AgentStreamHttpError with its code', async () => {
  const fakeFetch = async () => new Response(
    JSON.stringify({ success: false, error: { code: 'CANVAS_AGENT_RATE_LIMITED', message: '请求过于频繁' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  )
  await assert.rejects(
    collect(streamAgentEvents('/api/canvases/c1/agent/messages', { kind: 'user', messageId: 'm', text: 'hi', baseRevision: 1 }, { fetchImpl: fakeFetch })),
    (error) => {
      assert.ok(error instanceof AgentStreamHttpError)
      assert.equal(error.code, 'CANVAS_AGENT_RATE_LIMITED')
      assert.equal(error.status, 429)
      return true
    },
  )
})

test('a server error event is terminal and does not raise a disconnect', async () => {
  const input = frame('error', { type: 'error', turnId: 't1', eventId: 'e1', code: 'CANVAS_AGENT_FAILED', message: 'boom', retryable: true })
  const events = await collect(parseAgentEventStream(byteStream([input])))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
})

test('EOF before a done event surfaces a disconnect and never retries the POST', async () => {
  let calls = 0
  const fakeFetch = async () => {
    calls += 1
    return new Response(byteStream([frame('text_delta', { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'partial' })]), { status: 200 })
  }
  const generator = streamAgentEvents('/api/canvases/c1/agent/messages', { kind: 'user', messageId: 'm', text: 'hi', baseRevision: 1 }, { fetchImpl: fakeFetch })
  const seen = []
  await assert.rejects(
    (async () => { for await (const event of generator) seen.push(event.type) })(),
    AgentStreamDisconnectedError,
  )
  assert.deepEqual(seen, ['text_delta'])
  assert.equal(calls, 1)
})

test('an aborted read propagates the abort reason instead of a disconnect', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    collect(parseAgentEventStream(byteStream([frame('text_delta', { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'x' })]), { signal: controller.signal })),
    (error) => error.name === 'AbortError',
  )
})
