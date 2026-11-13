'use client'

// Canvas Agent 的 POST-SSE 客户端（纯解析逻辑可在 node --test 下运行）。
//
// 服务端每个事件写成 `event: <type>\ndata: <整个事件 JSON>\n\n`，并夹杂
// `: connected` / `: heartbeat` 注释帧。JSON 负载才是事件身份的权威来源。
// POST-SSE 没有 Last-Event-ID 重放协议：EOF 未收到终态帧时抛断线错误，
// 由调用方读取持久化 history/turn 恢复，绝不自动重发（重发可能二次创建任务）。

import type { AgentStreamEvent, CanvasAgentMessageRequest } from '@musecanvas/contracts'

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

/** 与 client-api 相同的 base 解析规则：默认同源 `/api` 反代。 */
export function resolveAgentStreamUrl(path: string): string {
  if (!API_BASE_URL) return path
  if (API_BASE_URL.endsWith('/api') && path.startsWith('/api/')) return API_BASE_URL + path.slice(4)
  return API_BASE_URL + path
}

/** HTTP 层拒绝：POST 没产出事件流。code 来自 `{ success:false, error }`，否则 HTTP_<status>。 */
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

/** 流在终态帧之前结束：诚实报告断线，不伪造完成、不重试。 */
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

/** 事件结构校验：只需 type/turnId/eventId 三个身份字段。 */
export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.type === 'string' &&
    EVENT_TYPES.has(candidate.type as AgentStreamEvent['type']) &&
    typeof candidate.turnId === 'string' &&
    typeof candidate.eventId === 'string'
  )
}

export interface ParsedAgentFrame {
  event: AgentStreamEvent
  terminal: boolean
}

/** 解析一帧（两个空行之间的文本）。注释帧/坏 JSON/未知事件类型返回 null。 */
export function parseAgentFrame(frame: string): ParsedAgentFrame | null {
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
  // 帧头与负载类型不一致视为损坏帧：负载是权威，但不能按错误标签信任。
  if (eventName !== null && eventName !== parsed.type) return null
  return { event: parsed, terminal: parsed.type === 'done' || parsed.type === 'error' }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

export interface ParseAgentStreamOptions {
  signal?: AbortSignal
}

/**
 * 解码 SSE 字节流：流式 UTF-8、CRLF 归一、多行 data 合并；
 * 没有终态帧就抛 `AgentStreamDisconnectedError`，被中止则原样抛中止原因。
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
  /** 测试注入点；默认环境 fetch。 */
  fetchImpl?: typeof fetch
}

/**
 * POST 一条 Agent 消息并流式产出事件。`path` 必须来自
 * `API_ENDPOINTS.canvases.agent.messages(canvasId)`。永不重试。
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
    // 非 JSON（代理错误页/空响应）：保留 HTTP 兜底。
  }
  return new AgentStreamHttpError(code, message, response.status)
}

/**
 * 同 tick 双击保护：必须在第一个 await 之前同步占锁，
 * 否则 click 与 form submit 会各自发起一轮请求。
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
