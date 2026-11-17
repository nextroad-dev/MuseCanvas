'use client'

// Agent Core V1 SSE 重放客户端（`GET /api/agent/sessions/:id/events?cursor=<cursor>`）。
//
// 协议约束（见 apps/api/src/modules/agent/sse.ts & validation.ts）：
// - 仅通过 `?cursor=<cursor>` 传递续传游标，绝不同时发送可能冲突的 `Last-Event-ID` 头；
// - 帧格式为 `id: <sessionId>:<cursor>` + `event: <type>` + `data: <JSON>`；
// - 服务端约 25s 主动结束有限流（clean bounded EOF），需由上层无缝重连；
// - 区分开流前 HTTP JSON 错误（ApiError: 404/503/409/...）、正常有限 EOF 与意外网络断流。

import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  AgentDecimal,
  AgentEventEnvelope,
  AgentTransportFrame,
} from '@musecanvas/contracts'
import { ApiError, resolveApiUrl } from './api'

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,18})$/

const TRANSPORT_FRAME_TYPES = new Set<AgentTransportFrame['type']>([
  'ready',
  'heartbeat',
  'resync.required',
])

const EVENT_TYPES = new Set<AgentEventEnvelope['type']>([
  'item.created',
  'tool.updated',
  'approval.required',
  'turn.updated',
])

export type ParsedAgentReplayItem =
  | {
      kind: 'transport'
      frame: AgentTransportFrame
      eventId: string | null
      cursor: AgentDecimal | null
    }
  | {
      kind: 'event'
      event: AgentEventEnvelope
      eventId: string | null
      cursor: AgentDecimal
    }

export class AgentEventStreamError extends ApiError {
  constructor(code: 'NETWORK_ERROR' | 'STREAM_TRUNCATED' | 'STREAM_UNAVAILABLE', message: string) {
    super(0, code, message)
    this.name = 'AgentEventStreamError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentDecimal(value: unknown): value is AgentDecimal {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value)
}

function parseReplayId(rawId: string): { sessionId: string; cursor: AgentDecimal } | null {
  const parts = rawId.split(':')
  if (parts.length !== 2) return null
  const [sessionId, cursor] = parts
  if (!sessionId || !isAgentDecimal(cursor)) return null
  return { sessionId, cursor }
}

function isValidTransportFrame(value: Record<string, unknown>): value is AgentTransportFrame {
  if (typeof value.type !== 'string' || !TRANSPORT_FRAME_TYPES.has(value.type as AgentTransportFrame['type'])) {
    return false
  }
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false
  switch (value.type) {
    case 'ready':
      return isAgentDecimal(value.highWater)
    case 'heartbeat':
      return isAgentDecimal(value.cursor)
    case 'resync.required':
      return value.reason === 'retention' || value.reason === 'backlog' || value.reason === 'unavailable'
    default:
      return false
  }
}

function isValidEventPayload(type: AgentEventEnvelope['type'], payload: unknown): boolean {
  if (!isPlainObject(payload)) return false
  switch (type) {
    case 'item.created':
      return (
        isPlainObject(payload.item) &&
        typeof payload.item.id === 'string' &&
        isAgentDecimal(payload.item.sequence) &&
        typeof payload.item.type === 'string'
      )
    case 'tool.updated':
      return (
        isPlainObject(payload.tool) &&
        typeof payload.tool.id === 'string' &&
        typeof payload.tool.turnId === 'string' &&
        typeof payload.tool.toolName === 'string' &&
        typeof payload.tool.status === 'string' &&
        isAgentDecimal(payload.tool.revision)
      )
    case 'approval.required':
      return (
        isPlainObject(payload.approval) &&
        typeof payload.approval.id === 'string' &&
        typeof payload.approval.turnId === 'string' &&
        typeof payload.approval.toolCallId === 'string' &&
        typeof payload.approval.status === 'string' &&
        isAgentDecimal(payload.approval.revision)
      )
    case 'turn.updated':
      return (
        isPlainObject(payload.turn) &&
        typeof payload.turn.id === 'string' &&
        typeof payload.turn.sessionId === 'string' &&
        typeof payload.turn.status === 'string' &&
        isAgentDecimal(payload.turn.revision)
      )
  }
}

function isValidEventEnvelope(value: Record<string, unknown>): value is AgentEventEnvelope {
  if (value.schemaVersion !== 1) return false
  if (typeof value.eventId !== 'string' || !value.eventId) return false
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false
  if (value.turnId !== null && typeof value.turnId !== 'string') return false
  if (typeof value.type !== 'string' || !EVENT_TYPES.has(value.type as AgentEventEnvelope['type'])) return false
  if (typeof value.createdAt !== 'string') return false
  if (!isAgentDecimal(value.cursor)) return false
  if (value.itemSequence !== null && !isAgentDecimal(value.itemSequence)) return false
  if (value.entityRevision !== null && !isAgentDecimal(value.entityRevision)) return false
  return isValidEventPayload(value.type as AgentEventEnvelope['type'], value.payload)
}

function hasOnlyCommentsOrWhitespace(frame: string): boolean {
  return frame
    .split('\n')
    .every((raw) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      return line === '' || line.startsWith(':')
    })
}

/** 解析单帧 SSE 文本；注释帧返回 null，协议字段不一致或损坏则返回 null。 */
export function parseAgentReplayFrame(
  frame: string,
  expectedSessionId?: string,
): ParsedAgentReplayItem | null {
  let idRaw: string | null = null
  let eventName: string | null = null
  const dataLines: string[] = []

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') idRaw = value
    else if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n')
  if (payload.trim() === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null

  const frameType = parsed.type
  if (typeof frameType !== 'string') return null
  if (eventName !== null && eventName !== frameType) return null
  if (expectedSessionId && parsed.sessionId !== expectedSessionId) return null

  let parsedId: { sessionId: string; cursor: AgentDecimal } | null = null
  if (idRaw !== null) {
    parsedId = parseReplayId(idRaw)
    if (!parsedId || parsedId.sessionId !== parsed.sessionId) return null
  }

  if (isValidTransportFrame(parsed)) {
    return {
      kind: 'transport',
      frame: parsed,
      eventId: idRaw,
      cursor: parsedId?.cursor ?? (parsed.type === 'heartbeat' ? parsed.cursor : null),
    }
  }

  if (isValidEventEnvelope(parsed)) {
    if (parsedId && parsedId.cursor !== parsed.cursor) return null
    return {
      kind: 'event',
      event: parsed,
      eventId: idRaw,
      cursor: parsed.cursor,
    }
  }

  return null
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

export interface ParseAgentReplayStreamOptions {
  signal?: AbortSignal
  sessionId?: string
}

/**
 * 解码 Agent Core SSE 字节流：
 * - 正常有限 EOF（双换行或完整帧结束）时干净结束，不抛错；
 * - 流读取过程中报错或出现未闭合的残缺帧时抛出 `AgentEventStreamError`（视为网络中断）；
 * - `signal` 中止时抛出中止错误。
 */
export async function* parseAgentReplayStream(
  body: ReadableStream<Uint8Array>,
  options: ParseAgentReplayStreamOptions = {},
): AsyncGenerator<ParsedAgentReplayItem, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      if (options.signal?.aborted) throw abortErrorFromSignal(options.signal)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (options.signal?.aborted) throw abortErrorFromSignal(options.signal)
        throw new AgentEventStreamError(
          'NETWORK_ERROR',
          error instanceof Error && error.message ? error.message : '事件流连接中断',
        )
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!hasOnlyCommentsOrWhitespace(frame)) {
          const parsed = parseAgentReplayFrame(frame, options.sessionId)
          if (parsed) yield parsed
        }
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer += decoder.decode()
    buffer = buffer.replace(/\r\n/g, '\n')
    const tail = buffer.replace(/^\n+/, '')
    if (tail.trim() !== '' && !hasOnlyCommentsOrWhitespace(tail)) {
      const parsed = parseAgentReplayFrame(tail, options.sessionId)
      if (!parsed) {
        throw new AgentEventStreamError('STREAM_TRUNCATED', '事件流在帧完成前意外断开')
      }
      yield parsed
    }
  } finally {
    try {
      if (options.signal?.aborted) await reader.cancel().catch(() => {})
    } finally {
      reader.releaseLock()
    }
  }
}

async function parseHttpError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`
  let message = response.status === 404
    ? 'Agent 服务未启用或会话不存在'
    : response.status === 503
      ? 'Agent 服务暂不可用'
      : 'Agent 事件流连接失败'
  try {
    const text = await response.text()
    if (text) {
      const parsed = JSON.parse(text) as {
        success?: unknown
        error?: { code?: unknown; message?: unknown; details?: unknown }
      }
      if (parsed && parsed.success === false && parsed.error) {
        if (typeof parsed.error.code === 'string' && parsed.error.code) code = parsed.error.code
        if (typeof parsed.error.message === 'string' && parsed.error.message) message = parsed.error.message
        return new ApiError(
          response.status,
          code,
          message,
          parsed.error.details as ConstructorParameters<typeof ApiError>[3],
        )
      }
    }
  } catch {
    // 非 JSON 错误体（代理 HTML 或空正文）：回落到状态码默认文案。
  }
  return new ApiError(response.status, code, message)
}

export type AgentReplaySource = (input: {
  url: string
  sessionId: string
  cursor: AgentDecimal
  limit?: number
  signal?: AbortSignal
}) => Promise<Response>

export interface SubscribeAgentEventsOptions {
  sessionId: string
  cursor?: AgentDecimal
  limit?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** 可注入自定义流源（测试或本地 mock 适配用），不传则走浏览器 fetch。 */
  source?: AgentReplaySource
  onTransport?: (frame: AgentTransportFrame) => void
  onEvent?: (event: AgentEventEnvelope) => void
}

export interface SubscribeAgentEventsResult {
  outcome: 'eof' | 'resync_required' | 'aborted'
  lastCursor: AgentDecimal
  resyncReason?: 'retention' | 'backlog' | 'unavailable'
}

/**
 * 订阅单次有界 SSE 重放流：
 * - HTTP 4xx/5xx 在开流前直接抛出 `ApiError`（保留 status/code/message）；
 * - 网络请求或流中断抛出 `AgentEventStreamError`；
 * - 服务端 25s 正常收尾返回 `{ outcome: 'eof', lastCursor }`；
 * - 收到 `resync.required` 帧返回 `{ outcome: 'resync_required', resyncReason, lastCursor }`；
 * - 被 AbortSignal 中止返回 `{ outcome: 'aborted', lastCursor }`。
 */
export async function subscribeAgentEvents(
  options: SubscribeAgentEventsOptions,
): Promise<SubscribeAgentEventsResult> {
  const cursor = options.cursor ?? '0'
  if (options.signal?.aborted) {
    return { outcome: 'aborted', lastCursor: cursor }
  }

  const url = resolveApiUrl(API_ENDPOINTS.agent.events(options.sessionId), {
    cursor,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  })

  let response: Response
  try {
    if (options.source) {
      response = await options.source({
        url,
        sessionId: options.sessionId,
        cursor,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } else {
      const doFetch = options.fetchImpl ?? fetch
      response = await doFetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        credentials: 'include',
        cache: 'no-store',
        signal: options.signal,
      })
    }
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { outcome: 'aborted', lastCursor: cursor }
    }
    throw new AgentEventStreamError(
      'NETWORK_ERROR',
      error instanceof Error && error.message ? error.message : '网络连接失败',
    )
  }

  if (!response.ok) {
    throw await parseHttpError(response)
  }
  if (!response.body) {
    throw new AgentEventStreamError('STREAM_UNAVAILABLE', '服务器未返回事件流')
  }

  let lastCursor: AgentDecimal = cursor
  let resyncReason: 'retention' | 'backlog' | 'unavailable' | undefined

  try {
    for await (const item of parseAgentReplayStream(response.body, {
      signal: options.signal,
      sessionId: options.sessionId,
    })) {
      if (item.kind === 'transport') {
        if (item.frame.type === 'heartbeat' && BigInt(item.frame.cursor) > BigInt(lastCursor)) {
          lastCursor = item.frame.cursor
        }
        options.onTransport?.(item.frame)
        if (item.frame.type === 'resync.required') {
          resyncReason = item.frame.reason
        }
      } else {
        if (BigInt(item.event.cursor) > BigInt(lastCursor)) {
          lastCursor = item.event.cursor
        }
        options.onEvent?.(item.event)
      }
    }
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { outcome: 'aborted', lastCursor }
    }
    throw error
  }

  if (options.signal?.aborted) {
    return { outcome: 'aborted', lastCursor }
  }
  if (resyncReason !== undefined) {
    return { outcome: 'resync_required', lastCursor, resyncReason }
  }
  return { outcome: 'eof', lastCursor }
}
