import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'

// Redis is bootstrap-only: URL comes from the deployment environment and is
// validated by assertBootstrapConfig() at worker startup. S3 is intentionally
// absent here; storage resolves lazily per settings revision via
// ../shared/storage.ts so the worker starts before onboarding and observes
// storage changes without a restart.
export const redis = createClient({ url: process.env.REDIS_URL }); redis.on('error', error => console.error('redis error', { code: error.name }))
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
