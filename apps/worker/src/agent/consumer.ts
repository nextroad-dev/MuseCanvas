import type { AgentMediaEventHandler, AgentRunner } from './ports'

export interface AgentStreamMessage { id: string; message: Record<string, string> }
export interface AgentConsumerQueue {
  initialize(): Promise<void>
  read(count: number): Promise<AgentStreamMessage[]>
  reclaim(cursor: string, count: number): Promise<{ cursor: string; messages: AgentStreamMessage[] }>
  heartbeatExists(id: string): Promise<boolean>
  heartbeat(id: string): Promise<void>
  ack(id: string): Promise<void>
  close(): void
}
export interface AgentConsumerOptions { signal: AbortSignal; concurrency?: number; heartbeatMs?: number; onActivity?: () => void; onError?: (code: string) => void }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** A malformed command stays pending for explicit repair; it cannot be ACKed as completed. */
export function createAgentWakeHandler(runner: AgentRunner) {
  return async (fields: Record<string, string>): Promise<'ack' | 'retry'> => {
    if (!uuid(fields.eventId) || !uuid(fields.sessionId) || !uuid(fields.turnId) || !/^(0|[1-9]\d{0,18})$/.test(fields.revision ?? '') || BigInt(fields.revision!) > 9223372036854775807n) return 'retry'
    await runner.runTurn({ eventId: fields.eventId, sessionId: fields.sessionId, turnId: fields.turnId, revision: fields.revision as `${bigint}` })
    return 'ack'
  }
}
export function createAgentMediaWakeHandler(handler: AgentMediaEventHandler) {
  return (fields: Record<string,string>): Promise<'ack'|'retry'> => !uuid(fields.eventId) || !uuid(fields.jobId)
    ? Promise.resolve('retry') : handler({ eventId: fields.eventId, jobId: fields.jobId })
}

export async function superviseWorkerLoops(loops: readonly (() => Promise<unknown>)[], controller: AbortController): Promise<void> {
  let firstFailure: unknown
  let failed=false
  const tasks=loops.map(async run=>{
    try { await run() }
    catch(error) {
      if (!failed) { firstFailure=error; failed=true }
      controller.abort()
      throw error
    }
  })
  const results=await Promise.allSettled(tasks)
  if(failed)throw firstFailure
  const rejected=results.find((result):result is PromiseRejectedResult=>result.status==='rejected')
  if(rejected)throw rejected.reason
}

/** Dedicated stream/group port. Capacity is acquired before reading/reclaiming. */
export async function consumeAgentStream(queue: AgentConsumerQueue, handler: (fields: Record<string,string>) => Promise<'ack'|'retry'>, options: AgentConsumerOptions): Promise<void> {
  const concurrency = options.concurrency ?? 2
  const heartbeatMs = options.heartbeatMs ?? 15_000
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('INVALID_AGENT_CONSUMER_CONFIG')
  const active = new Map<string,Promise<void>>()
  let cursor = '0-0'
  const start = (message: AgentStreamMessage) => {
    // Reading can complete after shutdown. Its pending entry is deliberately
    // retained, because no task has been scheduled and nothing is durable yet.
    if (options.signal.aborted || active.size >= concurrency || active.has(message.id)) return
    const task = (async () => {
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let renewing = false
      try {
        await queue.heartbeat(message.id)
        heartbeat = setInterval(() => {
          if (renewing) return
          renewing = true
          void queue.heartbeat(message.id).then(() => options.onActivity?.()).catch(() => options.onError?.('AGENT_HEARTBEAT_FAILED')).finally(() => { renewing = false })
        },heartbeatMs)
        const outcome = await handler(message.message)
        if (outcome === 'ack') await queue.ack(message.id)
        options.onActivity?.()
      } catch { options.onError?.('AGENT_MESSAGE_RETRY') }
      finally { clearInterval(heartbeat); active.delete(message.id) }
    })()
    active.set(message.id,task)
  }
  try {
    await queue.initialize()
    while (!options.signal.aborted) {
      if (active.size >= concurrency) { await Promise.race(active.values()); continue }
      const claimed = await queue.reclaim(cursor,concurrency-active.size)
      cursor = claimed.cursor
      for (const message of claimed.messages) {
        if (!await queue.heartbeatExists(message.id)) start(message)
      }
      if (options.signal.aborted || active.size >= concurrency) continue
      const fresh = await queue.read(concurrency-active.size)
      options.onActivity?.()
      for (const message of fresh) start(message)
    }
  } finally {
    queue.close()
    await Promise.allSettled(active.values())
  }
}
