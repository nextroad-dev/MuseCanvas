'use client'

// Client for the Canvas Agent POST SSE endpoint.
//
// The JSON client in `shared/services/client-api` buffers the whole response and
// parses one JSON body, so it cannot be used for `text/event-stream`. This module
// owns the one raw-`fetch` boundary instead: it opens the POST, validates the
// HTTP/JSON error envelope, and turns the byte stream into typed
// `AgentStreamEvent`s. It is deliberately React-free so the framing rules can be
// unit-tested against a synthetic stream (split UTF-8 chunks, CRLF, multi-line
// data, heartbeats, premature EOF).
//
// The server writes one frame per event as
//   event: <type>\n data: <json>\n\n
// plus `: connected` / `: heartbeat` comment frames. A frame's `data:` line(s)
// carry the entire event object, so the JSON payload — not the `event:` name — is
// authoritative. Unknown fields are ignored; unknown event types are dropped.
//
// A POST SSE stream has no replay/Last-Event-ID protocol, so EOF before a terminal
// event is an honest "connection lost" state. It must never silently retry or
// resend the request: the turn may already have created a job, and a resend would
// ask the model for a second one. The caller surfaces `AgentStreamDisconnectedError`
// and recovers by reading persisted history/turn facts instead.

import type { AgentStreamEvent, CanvasAgentMessageRequest } from '@musecanvas/contracts'

/** `process.env.NEXT_PUBLIC_API_BASE_URL` is inlined at build time; mirror the
 *  base-URL rule in `shared/services/client-api` so the SSE POST reaches the same
 *  origin/proxy as every JSON call. The caller passes the `API_ENDPOINTS` path
 *  (never a hardcoded literal), keeping this module free of a runtime contracts
 *  import so its framing can be tested under plain `node --test`. */
const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

export function resolveAgentStreamUrl(path: string): string {
  if (BASE_URL.endsWith('/api') && path.startsWith('/api/')) return BASE_URL + path.slice(4)
  return BASE_URL + path
}

/** HTTP-level rejection: the POST never produced an event stream. `code` is the
 *  `{ success: false, error }` code when the server sent one, else `HTTP_<status>`. */
export class AgentStreamHttpError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'AgentStreamHttpError'
    this.code = code
    this.status = status
  }
}

/** The stream ended without a `done`/`error` terminal frame. Honest disconnect:
 *  callers must not retry the POST or fabricate a completed turn. */
export class AgentStreamDisconnectedError extends Error {
  constructor(message = '连接在完成前中断，任务可能已在后台创建，请刷新历史确认。') {
    super(message)
    this.name = 'AgentStreamDisconnectedError'
  }
}

const EVENT_TYPES = new Set<AgentStreamEvent['type']>([
  'text_delta',
  'tool_call',
  'tool_result',
  'canvas_ops',
  'pending_jobs',
  'confirm_required',
  'done',
  'error',
])

/** Structural validation of one decoded `data:` payload. Only the fields the
 *  reducer keys on are required (`type`, `turnId`); unknown extra fields are kept
 *  but never trusted for identity. */
export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.type === 'string'
    && EVENT_TYPES.has(candidate.type as AgentStreamEvent['type'])
    && typeof candidate.turnId === 'string'
    && typeof candidate.eventId === 'string'
}

interface ParsedFrame {
  event: AgentStreamEvent
  terminal: boolean
}

/** Parse a single frame body (the text between two blank lines). Returns `null`
 *  for comment-only frames, malformed JSON, and unknown event types. */
export function parseAgentFrame(frame: string): ParsedFrame | null {
  let eventName: string | null = null
  const data: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') eventName = value
    // `id:`/`retry:` and every unknown field are ignored on purpose: the JSON body
    // is the identity source, and event IDs are not a replay contract.
  }
  if (data.length === 0) return null
  const payload = data.join('\n')
  if (payload.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isAgentStreamEvent(parsed)) return null
  if (eventName !== null && eventName !== parsed.type) {
    // The frame's declared name disagrees with its payload. The payload is the
    // contract (`data:` = whole event); a mismatched frame is treated as corrupt
    // framing and dropped rather than trusted under the wrong label.
    return null
  }
  return { event: parsed, terminal: parsed.type === 'done' || parsed.type === 'error' }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new DOMException('The operation was aborted.', 'AbortError')
}

export interface ParseAgentStreamOptions {
  signal?: AbortSignal
}

/**
 * Decode a `ReadableStream<Uint8Array>` of SSE bytes into typed events.
 *
 * - `TextDecoder({ stream: true })` keeps a partial multi-byte UTF-8 sequence
 *   across chunk boundaries instead of emitting a replacement character.
 * - `\r\n` is normalised to `\n`, so CRLF servers frame identically.
 * - Frames are split on blank lines; multi-line `data:` fields are joined with
 *   `\n` as the SSE spec requires.
 *
 * After the body ends, a stream that never produced a terminal (`done`/`error`)
 * frame throws `AgentStreamDisconnectedError`. An aborted read propagates the
 * abort reason untouched so callers can distinguish a user/actor-switch stop from
 * a lost connection.
 */
export async function* parseAgentEventStream(
  body: ReadableStream<Uint8Array>,
  options: ParseAgentStreamOptions = {},
): AsyncGenerator<AgentStreamEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let terminal = false
  try {
    for (;;) {
      if (options.signal?.aborted) throw abortReason(options.signal)
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseAgentFrame(frame)
        if (parsed) {
          if (parsed.terminal) terminal = true
          yield parsed.event
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    // A well-formed server always terminates a frame with a blank line, but flush a
    // trailing frame anyway so a truncated-but-complete payload is not dropped.
    const tail = buffer.replace(/^\n+/, '')
    if (tail.trim() !== '') {
      const parsed = parseAgentFrame(tail)
      if (parsed) {
        if (parsed.terminal) terminal = true
        yield parsed.event
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!terminal) throw new AgentStreamDisconnectedError()
}

export interface AgentStreamOptions {
  signal?: AbortSignal
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * POST one `CanvasAgentMessageRequest` and stream its typed events. `path` is the
 * `API_ENDPOINTS.canvases.agent.messages(canvasId)` value. Non-OK responses are
 * decoded from the `{ success: false, error }` envelope and raised as
 * `AgentStreamHttpError`. Never retries.
 */
export async function* streamAgentEvents(
  path: string,
  request: CanvasAgentMessageRequest,
  options: AgentStreamOptions = {},
): AsyncGenerator<AgentStreamEvent, void, void> {
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(resolveAgentStreamUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include',
    signal: options.signal,
  })
  if (!response.ok) throw await httpErrorFrom(response)
  if (!response.body) throw new AgentStreamDisconnectedError('服务器未返回事件流，请刷新历史确认。')
  yield* parseAgentEventStream(response.body, { signal: options.signal })
}

async function httpErrorFrom(response: Response): Promise<AgentStreamHttpError> {
  let code = `HTTP_${response.status}`
  let message = 'Agent 请求失败，请稍后重试'
  try {
    const text = await response.text()
    if (text) {
      const parsed = JSON.parse(text) as { success?: unknown; error?: { code?: unknown; message?: unknown } }
      if (parsed && parsed.success === false && parsed.error) {
        if (typeof parsed.error.code === 'string') code = parsed.error.code
        if (typeof parsed.error.message === 'string') message = parsed.error.message
      }
    }
  } catch {
    // Non-JSON (proxy error page / empty body): keep the HTTP fallback.
  }
  return new AgentStreamHttpError(code, message, response.status)
}

/**
 * Synchronous guard against a double submit. One click can fire a click handler
 * and a form submit in the same tick; the store lock has to be claimed *before*
 * the first await, so both callers see the same decision.
 */
export function createAgentSubmitLock() {
  let locked = false
  return {
    get locked(): boolean {
      return locked
    },
    tryLock(): boolean {
      if (locked) return false
      locked = true
      return true
    },
    unlock(): void {
      locked = false
    },
  }
}

export type AgentSubmitLock = ReturnType<typeof createAgentSubmitLock>
