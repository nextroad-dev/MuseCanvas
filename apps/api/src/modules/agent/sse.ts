import { NextResponse } from 'next/server'
import type { AgentDecimal, AgentEventsPageDTO, AgentTransportFrame } from '@musecanvas/contracts'

interface ReplayOptions {
  sessionId: string
  cursor: AgentDecimal
  first: AgentEventsPageDTO
  poll: (cursor: AgentDecimal) => Promise<AgentEventsPageDTO>
  signal: AbortSignal
  lifetimeMs?: number
  pollMs?: number
  heartbeatMs?: number
  maxEvents?: number
}
/** Finite subscription only: each poll returns its PG connection before waiting. Stream cancellation never cancels a Turn. */
export function agentReplay(options: ReplayOptions): NextResponse {
  const { sessionId, signal } = options
  const encoder = new TextEncoder()
  const lifetimeMs = options.lifetimeMs ?? 25000
  const pollMs = options.pollMs ?? 500
  const heartbeatMs = options.heartbeatMs ?? 5000
  let cursor = options.cursor, page = options.first, index = 0, count = 0, bytes = 0
  let stopped = false, ready = false, lastHeartbeat = Date.now()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let lifetime: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let wakeWaiter: (() => void) | undefined
  const cleanup = () => {
    stopped = true
    if (lifetime) clearTimeout(lifetime)
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    wakeWaiter?.(); wakeWaiter = undefined
  }
  const close = () => { if (!stopped) { cleanup(); try { controller?.close() } catch { /* Consumer may already have cancelled. */ } } }
  const abort = () => close()
  const send = (event: string, data: unknown, at: AgentDecimal = cursor) => {
    if (stopped) return
    const frame = encoder.encode(`id: ${sessionId}:${at}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    bytes += frame.byteLength
    controller!.enqueue(frame)
  }
  const transport = (frame: AgentTransportFrame) => send(frame.type, frame)
  const resync = (reason: 'retention' | 'backlog' | 'unavailable') => {
    transport({ type: 'resync.required', sessionId, reason }); close()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      lifetime = setTimeout(close, lifetimeMs)
      if (signal.aborted) close()
    },
    async pull() {
      if (stopped) return
      if (!ready) { ready = true; transport({ type: 'ready', sessionId, highWater: page.highWater }); return }
      try {
        while (!stopped) {
          if (page.resyncRequired) { resync('retention'); return }
          if (index < page.events.length) {
            if (count >= (options.maxEvents ?? 500) || bytes > 1000000) { resync('backlog'); return }
            const event = page.events[index++]
            if (BigInt(event.cursor) !== BigInt(cursor) + 1n) { resync('retention'); return }
            cursor = event.cursor; count++
            send(event.type, event)
            return
          }
          if (Date.now() - lastHeartbeat >= heartbeatMs) {
            lastHeartbeat = Date.now(); transport({ type: 'heartbeat', sessionId, cursor }); return
          }
          if (!page.hasMore) await new Promise<void>(resolve => {
            wakeWaiter = resolve
            timer = setTimeout(() => { timer = undefined; wakeWaiter = undefined; resolve() }, pollMs)
          })
          if (stopped) return
          page = await options.poll(cursor); index = 0
        }
      } catch { if (!stopped) resync('unavailable') }
    },
    cancel() { cleanup() },
  }, { highWaterMark: 1 })
  return new NextResponse(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
