import { createClient } from 'redis'

let redis: ReturnType<typeof createClient> | undefined

/**
 * In-process fallback window, used only while Redis is unreachable.
 *
 * The old `catch { return false }` turned any Redis outage into a global
 * rate-limit bypass — every caller passed, which is exactly when abuse is most
 * attractive. Degrading to a local counter keeps each endpoint enforced (still
 * fail-closed in intent) instead of a blanket reject-all that would take the
 * whole API down with Redis. Tradeoff: the ceiling is per instance rather than
 * per cluster, so a multi-replica deployment is looser than the Redis path —
 * but bounded, cheap, and strictly safer than allowing everything.
 */
type LocalWindow = { count: number; expiresAt: number }
const localWindows = new Map<string, LocalWindow>()
const LOCAL_WINDOW_MAX_KEYS = 10_000

function limitedLocally(key: string, max: number, seconds: number): boolean {
  const now = Date.now()
  if (localWindows.size >= LOCAL_WINDOW_MAX_KEYS) {
    // Bound memory under a hostile key space: drop expired windows, then evict
    // oldest-first (Map preserves insertion order) if the cap is still reached.
    for (const [k, window] of localWindows) if (window.expiresAt <= now) localWindows.delete(k)
    while (localWindows.size >= LOCAL_WINDOW_MAX_KEYS) {
      const oldest = localWindows.keys().next().value
      if (oldest === undefined) break
      localWindows.delete(oldest)
    }
  }
  const window = localWindows.get(key)
  if (!window || window.expiresAt <= now) {
    localWindows.set(key, { count: 1, expiresAt: now + seconds * 1000 })
    return false
  }
  window.count += 1
  return window.count > max
}

export async function limited(key: string, max: number, seconds: number): Promise<boolean> {
  try {
    redis ??= createClient({ url: process.env.REDIS_URL })
    if (!redis.isOpen) await redis.connect()
    const count = (await redis.eval(
      "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return current",
      { keys: [`rate:${key}`], arguments: [String(seconds)] },
    )) as number
    return count > max
  } catch {
    // Redis is down: fall back to the local window instead of waving the request through.
    return limitedLocally(key, max, seconds)
  }
}

/** Bootstrap liveness probe. True when Redis answers PING, false otherwise. Never throws. */
export async function redisPing(timeoutMs = 2000): Promise<boolean> {
  try {
    redis ??= createClient({ url: process.env.REDIS_URL })
    if (!redis.isOpen) await redis.connect()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), timeoutMs)
    })
    try {
      await Promise.race([redis.ping(), timeout])
      return true
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
}

async function redisClient() {
  redis ??= createClient({ url: process.env.REDIS_URL })
  if (!redis.isOpen) await redis.connect()
  return redis
}

export async function redisSet(key: string, value: object, ttlSeconds: number): Promise<void> {
  const client = await redisClient()
  await client.set(key, JSON.stringify(value), { EX: ttlSeconds })
}

export async function redisGetDel<T>(key: string): Promise<T | null> {
  const client = await redisClient()
  const raw = await client.getDel(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}