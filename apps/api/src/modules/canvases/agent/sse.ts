import { NextResponse } from 'next/server'
import type { AgentStreamEvent } from '@musecanvas/contracts'

export function agentStream(input: {
  signal: AbortSignal; timeoutMs: number
  run: (send: (event: AgentStreamEvent) => void, signal: AbortSignal) => Promise<void>
  cleanup: () => Promise<void>; heartbeatMs?: number
}): NextResponse {
  const abort = new AbortController(), encoder = new TextEncoder()
  let closed = false, heartbeat: ReturnType<typeof setInterval> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  const stop = () => {
    if (heartbeat) clearInterval(heartbeat)
    if (timer) clearTimeout(timer)
    input.signal.removeEventListener('abort', onAbort)
  }
  const onAbort = () => abort.abort('canceled')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) onAbort()
      timer = setTimeout(() => abort.abort('timeout'), input.timeoutMs)
      const enqueue = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)) }
      enqueue(': connected\n\n')
      heartbeat = setInterval(() => enqueue(': heartbeat\n\n'), input.heartbeatMs ?? 15_000)
      running = (async () => {
        try { await input.run(event => enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`), abort.signal) }
        finally {
          stop()
          try { await input.cleanup() } finally { if (!closed) { closed = true; controller.close() } }
        }
      })()
      // Run converts expected failures into SSE error events. Cleanup failures must not
      // become unhandled rejections or leak their exception strings to a disconnected client.
      void running.catch(() => { stop(); if (!closed) { closed = true; controller.close() } })
    },
    async cancel() { closed = true; stop(); abort.abort('canceled'); await running?.catch(() => undefined) },
  })
  return new NextResponse(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
