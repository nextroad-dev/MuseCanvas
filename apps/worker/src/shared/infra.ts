import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'

// Redis is bootstrap-only: URL comes from the deployment environment and is
// validated by assertBootstrapConfig() at worker startup. S3 is intentionally
// absent here; storage resolves lazily per settings revision via
// ../shared/storage.ts so the worker starts before onboarding and observes
// storage changes without a restart.
export function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_WORKER_CONFIG')
  return value
}

export const REDIS_COMMAND_TIMEOUT_MS = boundedInteger(process.env.WORKER_REDIS_COMMAND_TIMEOUT_MS, 5000, 1000, 60_000)
const options = { url: process.env.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 1024, commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS }, socket: { connectTimeout: boundedInteger(process.env.REDIS_CONNECT_TIMEOUT_MS, 1000, 100, 60_000) } }
export const redis = createClient(options)
// BLOCK must never queue heartbeats or outbox writes behind the read command.
export const blockingRedis = createClient({ ...options, commandOptions: { timeout: 15_000 } })
for (const client of [redis, blockingRedis]) client.on('error', error => console.error('redis error', { code: error.name }))

export async function redisCommand<T>(operation: Promise<T>, timeoutMs = REDIS_COMMAND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('REDIS_COMMAND_TIMEOUT')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
export const consumer = `worker-${process.pid}-${randomUUID().slice(0, 8)}`

export const GENERATION_STREAM = 'muse:generation'
export const GENERATION_GROUP = 'workers'
// Stale-idle threshold must stay below HEARTBEAT_TTL_MS: a crashed worker's
// in-flight messages are only retried once its heartbeat key lapses, never
// while it is still being renewed.
export const STALE_PENDING_IDLE_MS = 60_000
export const CONSUMER_BLOCK_MS = 5000
export const HEARTBEAT_TTL_MS = 90_000
export const HEARTBEAT_RENEW_MS = 15_000
