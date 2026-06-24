import { db } from '../../../../packages/database/src/index'
import { consumer, redis } from '../shared/infra'

export async function acquire(modelId: string, limit: number, owner: string): Promise<boolean> {
  const key = `permit:${modelId}`; const now = Date.now(); const expires = now + Number(process.env.JOB_LEASE_MS || 600_000)
  const result = await redis.eval(`redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1]) < tonumber(ARGV[2]) then redis.call('ZADD',KEYS[1],ARGV[3],ARGV[4]); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])-tonumber(ARGV[1])+60000); return 1 end; return 0`, { keys: [key], arguments: [String(now), String(limit), String(expires), owner] })
  return result === 1
}
export async function release(modelId: string, owner: string) { await redis.zRem(`permit:${modelId}`, owner) }

export async function dispatchOutbox() {
  const events = await db().query("SELECT id,aggregate_id FROM outbox_events WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100")
  for (const event of events.rows) { try { await redis.xAdd('muse:generation', '*', { jobId: event.aggregate_id, eventId: event.id }); await db().query('UPDATE outbox_events SET dispatched_at=now(),attempts=attempts+1 WHERE id=$1', [event.id]) } catch { await db().query('UPDATE outbox_events SET attempts=attempts+1 WHERE id=$1', [event.id]) } }
}

export async function consume(processJob: (jobId: string) => Promise<boolean>) {
  try { await redis.xGroupCreate('muse:generation', 'workers', '0', { MKSTREAM: true }) } catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error }
  while (true) {
    const messages = await redis.xReadGroup('workers', consumer, { key: 'muse:generation', id: '>' }, { COUNT: 1, BLOCK: 5000 }) as Array<{ messages: Array<{ id: string; message: Record<string, string> }> }> | null
    for (const stream of messages || []) for (const message of stream.messages) { const handled = await processJob(message.message.jobId); if (!handled) { await new Promise(resolve => setTimeout(resolve, 1000)); await redis.xAdd('muse:generation', '*', { jobId: message.message.jobId, eventId: message.message.eventId || 'permit-retry' }) } await redis.xAck('muse:generation', 'workers', message.id) }
  }
}
