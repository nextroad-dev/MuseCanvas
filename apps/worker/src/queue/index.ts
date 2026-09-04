import { db } from '../../../../packages/database/src/index'
import { CONSUMER_BLOCK_MS, GENERATION_GROUP, GENERATION_STREAM, STALE_PENDING_IDLE_MS, consumer, redis } from '../shared/infra'
import { resolveJobLeaseMs } from '../shared/runtime'

export async function acquire(modelId: string, limit: number, owner: string): Promise<boolean> {
  // Lease window comes from runtime settings (DB first, legacy JOB_LEASE_MS
  // env second, contract default last); a resolver failure falls back to the
  // contract default so queue pressure never wedges on a settings read.
  const leaseMs = await resolveJobLeaseMs().catch(() => 600_000)
  const key = `permit:${modelId}`; const now = Date.now(); const expires = now + leaseMs
  const result = await redis.eval(`redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1]) < tonumber(ARGV[2]) then redis.call('ZADD',KEYS[1],ARGV[3],ARGV[4]); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])-tonumber(ARGV[1])+60000); return 1 end; return 0`, { keys: [key], arguments: [String(now), String(limit), String(expires), owner] })
  return result === 1
}
export async function release(modelId: string, owner: string) { await redis.zRem(`permit:${modelId}`, owner) }

export async function dispatchOutbox() {
  const events = await db().query(
    "SELECT id,aggregate_id,payload FROM outbox_events WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED",
  )
  for (const event of events.rows) {
    const payload = (event.payload as Record<string, unknown>) || {}
    try {
      await redis.xAdd(GENERATION_STREAM, '*', {
        jobId: String((payload.jobId as string) || event.aggregate_id),
        runId: String((payload.runId as string) || ''),
        eventId: String(event.id),
      })
      await db().query('UPDATE outbox_events SET dispatched_at=now(),attempts=attempts+1 WHERE id=$1', [event.id])
    } catch {
      await db().query('UPDATE outbox_events SET attempts=attempts+1 WHERE id=$1', [event.id])
    }
  }
}

type StreamMessage = { id: string; message: Record<string, string> }

function extractMessages(reply: unknown): StreamMessage[] {
  if (!reply) return []
  const out: StreamMessage[] = []
  const push = (id: string, message: Record<string, string>) => out.push({ id, message })
  if (Array.isArray(reply)) {
    for (const stream of reply as Array<{ messages?: StreamMessage[] }>) {
      for (const message of stream?.messages || []) push(message.id, message.message)
    }
    return out
  }
  if (typeof reply === 'object' && reply !== null) {
    const maybe = reply as { messages?: StreamMessage[] }
    if (Array.isArray(maybe.messages)) {
      for (const message of maybe.messages) push(message.id, message.message)
    }
  }
  return out
}

async function claimStalePending(): Promise<StreamMessage[]> {
  try {
    const client = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    if (typeof client.xAutoClaim !== 'function') return []
    const reply = await client.xAutoClaim(GENERATION_STREAM, GENERATION_GROUP, consumer, STALE_PENDING_IDLE_MS, '0-0', { COUNT: 10 })
    const normalized = reply as { messages?: StreamMessage[] } | StreamMessage[] | null
    if (!normalized) return []
    if (Array.isArray(normalized)) return normalized as StreamMessage[]
    if (Array.isArray((normalized as { messages?: StreamMessage[] }).messages)) {
      return (normalized as { messages: StreamMessage[] }).messages
    }
    return []
  } catch {
    return []
  }
}

export async function consume(processJob: (jobId: string, runId?: string) => Promise<boolean>) {
  try { await redis.xGroupCreate(GENERATION_STREAM, GENERATION_GROUP, '0', { MKSTREAM: true }) } catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error }
  while (true) {
    const stale = await claimStalePending()
    for (const message of stale) {
      const jobId = message.message.jobId
      const runId = message.message.runId || undefined
      if (!jobId) {
        await redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id)
        continue
      }
      try {
        await processJob(jobId, runId)
        await redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id)
      } catch (error) {
        console.error('stale job processing failed', { code: error instanceof Error ? error.name : 'JOB_FAILED' })
      }
    }
    const reply = await redis.xReadGroup(GENERATION_GROUP, consumer, { key: GENERATION_STREAM, id: '>' }, { COUNT: 10, BLOCK: CONSUMER_BLOCK_MS }) as unknown
    for (const message of extractMessages(reply)) {
      const jobId = message.message.jobId
      const runId = message.message.runId || undefined
      if (!jobId) {
        await redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id)
        continue
      }
      try {
        await processJob(jobId, runId)
        await redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id)
      } catch (error) {
        console.error('job processing failed', { code: error instanceof Error ? error.name : 'JOB_FAILED' })
      }
    }
  }
}
