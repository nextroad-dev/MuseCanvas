import { db } from '@musecanvas/database'
import { randomUUID } from 'node:crypto'
import { CONSUMER_BLOCK_MS, GENERATION_GROUP, GENERATION_STREAM, HEARTBEAT_RENEW_MS, HEARTBEAT_TTL_MS, STALE_PENDING_IDLE_MS, blockingRedis, boundedInteger, consumer, redis, redisCommand } from '../shared/infra'
import { resolveJobLeaseMs } from '../shared/runtime'

// Heartbeat keys mark a message as in-flight so another worker's XAUTOCLAIM
// skips it (see claimStalePending). Keys are never deleted; TTL expiry plus
// the claim-side exists() check bound recovery.
const heartbeatKey = (messageId: string) => `hb:gen-msg:${messageId}`
const writeHeartbeat = (messageId: string) =>
  redisCommand(redis.set(heartbeatKey(messageId), '1', { expiration: { type: 'PX', value: HEARTBEAT_TTL_MS } }))

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

export async function dispatchOutbox(client: Pick<ReturnType<typeof db>, 'query'> = db()) {
  const token = randomUUID()
  // The CTE row locks live only for this statement, never over network I/O.
  const events = await client.query(
    `WITH ready AS (
      SELECT id FROM outbox_events WHERE dispatched_at IS NULL
        AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at <= now())
      ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED
    ) UPDATE outbox_events e SET dispatch_token=$1, dispatch_lease_expires_at=now()+interval '120 seconds', attempts=attempts+1
      FROM ready WHERE e.id=ready.id RETURNING e.id,e.aggregate_id,e.payload`, [token],
  )
  await Promise.all(events.rows.map(async event => {
    const payload = (event.payload as Record<string, unknown>) || {}
    try {
      await redisCommand(redis.xAdd(GENERATION_STREAM, '*', {
        jobId: String((payload.jobId as string) || event.aggregate_id),
        runId: String((payload.runId as string) || ''),
        eventId: String(event.id),
      }))
      await client.query('UPDATE outbox_events SET dispatched_at=now(),dispatch_token=NULL,dispatch_lease_expires_at=NULL WHERE id=$1 AND dispatch_token=$2 AND dispatch_lease_expires_at>now()', [event.id, token])
    } catch {
      await client.query('UPDATE outbox_events SET dispatch_token=NULL,dispatch_lease_expires_at=NULL WHERE id=$1 AND dispatch_token=$2', [event.id, token])
    }
  }))
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

async function claimStalePending(count: number): Promise<StreamMessage[]> {
  try {
    const client = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    if (typeof client.xAutoClaim !== 'function') return []
    const reply = await redisCommand(client.xAutoClaim(GENERATION_STREAM, GENERATION_GROUP, consumer, STALE_PENDING_IDLE_MS, '0-0', { COUNT: count }))
    const normalized = reply as { messages?: StreamMessage[] } | StreamMessage[] | null
    if (!normalized) return []
    const claimed = Array.isArray(normalized)
      ? normalized as StreamMessage[]
      : Array.isArray((normalized as { messages?: StreamMessage[] }).messages) ? (normalized as { messages: StreamMessage[] }).messages : []
    const claimable: StreamMessage[] = []
    for (const message of claimed) {
      // Skipping still counts as a claim (idle reset) and that is acceptable:
      // a live owner acks by message id once done, while a dead owner's key
      // expires (<=90s) and the next idle-threshold pass retries the message.
      if (!await redisCommand(redis.exists(heartbeatKey(message.id)))) claimable.push(message)
    }
    return claimable
  } catch {
    return []
  }
}

export interface ConsumeOptions { signal?: AbortSignal; onActivity?: () => void }

export async function consume(processJob: (jobId: string, runId?: string) => Promise<boolean>, options: ConsumeOptions = {}) {
  const concurrency = boundedInteger(process.env.WORKER_CONCURRENCY, 2, 1, 16)
  if (!blockingRedis.isOpen) await redisCommand(blockingRedis.connect())
  try { await redisCommand(redis.xGroupCreate(GENERATION_STREAM, GENERATION_GROUP, '0', { MKSTREAM: true })) } catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error }
  const active = new Set<Promise<void>>()
  const run = async (message: StreamMessage, logLabel: string) => {
    const jobId = message.message.jobId
    const runId = message.message.runId || undefined
    if (!jobId) {
      await redisCommand(redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id))
      return
    }
    let renewing = false
    const renew = setInterval(() => {
      if (renewing) return
      renewing = true
      void writeHeartbeat(message.id).then(() => options.onActivity?.()).catch(() => {}).finally(() => { renewing = false })
    }, HEARTBEAT_RENEW_MS)
    try {
      await writeHeartbeat(message.id)
      await processJob(jobId, runId)
      await redisCommand(redis.xAck(GENERATION_STREAM, GENERATION_GROUP, message.id))
      options.onActivity?.()
    } catch (error) {
      console.error(logLabel, { code: error instanceof Error ? error.name : 'JOB_FAILED' })
    } finally {
      clearInterval(renew)
    }
  }
  const start = (message: StreamMessage) => {
    const task = run(message, 'job processing failed').catch(() => {}).finally(() => { active.delete(task) })
    active.add(task)
  }
  try {
    while (!options.signal?.aborted) {
      if (active.size >= concurrency) { await Promise.race(active); continue }
      for (const message of await claimStalePending(concurrency - active.size)) start(message)
      if (active.size >= concurrency) continue
      const reply = await redisCommand(blockingRedis.xReadGroup(GENERATION_GROUP, consumer, { key: GENERATION_STREAM, id: '>' }, { COUNT: concurrency - active.size, BLOCK: CONSUMER_BLOCK_MS }), CONSUMER_BLOCK_MS + 10_000)
      options.onActivity?.()
      for (const message of extractMessages(reply)) start(message)
    }
  } finally {
    await Promise.allSettled(active)
    if (blockingRedis.isOpen) blockingRedis.destroy()
  }
}

// Compare stream IDs as decimal strings: Lua numbers lose millisecond sequence precision.
export const TRIM_GENERATION_STREAM_LUA = `
local function lt(a,b)
  local am,as=string.match(a,'^(%d+)%-(%d+)$'); local bm,bs=string.match(b,'^(%d+)%-(%d+)$')
  if #am~=#bm then return #am<#bm end
  if am~=bm then return am<bm end
  if #as~=#bs then return #as<#bs end
  return as<bs
end
if redis.call('EXISTS',KEYS[1])==0 then return 0 end
local groups=redis.call('XINFO','GROUPS',KEYS[1])
if #groups~=1 then return 0 end
local group={}; for i=1,#groups[1],2 do group[groups[1][i]]=groups[1][i+1] end
if group['name']~=ARGV[1] then return 0 end
local boundary=ARGV[2]
if lt(group['last-delivered-id'],boundary) then boundary=group['last-delivered-id'] end
local pending=redis.call('XPENDING',KEYS[1],ARGV[1])
if pending[1]>0 and lt(pending[2],boundary) then boundary=pending[2] end
local rows=redis.call('XRANGE',KEYS[1],'-','('..boundary,'COUNT',ARGV[3])
local removed=0
for _,row in ipairs(rows) do removed=removed+redis.call('XDEL',KEYS[1],row[1]) end
return removed
`

/** Only acknowledged, delivered entries older than the retention window are removed. */
export async function trimGenerationStream(): Promise<number> {
  const retention = boundedInteger(process.env.STREAM_RETENTION_SECONDS, 604_800, 0, 31_536_000)
  if (retention === 0) return 0
  const batch = boundedInteger(process.env.STREAM_TRIM_BATCH_SIZE, 1000, 1, 10_000)
  return Number(await redisCommand(redis.eval(TRIM_GENERATION_STREAM_LUA, {
    keys: [GENERATION_STREAM], arguments: [GENERATION_GROUP, `${Math.max(0, Date.now() - retention * 1000)}-0`, String(batch)],
  })))
}
