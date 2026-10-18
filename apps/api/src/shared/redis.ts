import { createClient } from 'redis'

type RedisClient = ReturnType<typeof createClient>
type RedisConnection = Pick<RedisClient, 'isReady' | 'isOpen' | 'on' | 'connect' | 'destroy' | 'eval' | 'ping' | 'set' | 'getDel'>

function timeoutSetting(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Shared by all Redis callers. A failed socket is discarded, never queued offline. */
export function createRedisAccess(
  factory: () => RedisConnection = () => createClient({
    url: process.env.REDIS_URL,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
    socket: { connectTimeout: timeoutSetting('REDIS_CONNECT_TIMEOUT_MS', 1000), reconnectStrategy: false },
  }),
  commandTimeoutMs = timeoutSetting('REDIS_COMMAND_TIMEOUT_MS', 1000),
) {
  let client: RedisConnection | undefined
  let connecting: Promise<RedisConnection> | undefined
  let retryAfter = 0
  let lastErrorLog = 0
  function discard(current: RedisConnection) {
    if (current === client) { client = undefined; retryAfter = Date.now() + 1000 }
    try { if (current.isOpen) current.destroy() } catch { /* Socket already closed. */ }
  }
  async function bounded<T>(work: Promise<T>, current: RedisConnection, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { discard(current); reject(new Error('REDIS_TIMEOUT')) }, timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  async function ready(): Promise<RedisConnection> {
    if (client?.isReady) return client
    if (connecting) return connecting
    if (Date.now() < retryAfter) throw new Error('REDIS_UNAVAILABLE')
    const current = factory()
    client = current
    current.on('error', () => {
      // Error events arrive outside command try/catch; redact upstream text and
      // bound outage logging even under many failed authentication requests.
      if (Date.now() - lastErrorLog > 10000) {
        lastErrorLog = Date.now()
        console.error('redis connection error', { code: 'REDIS_CONNECTION_ERROR' })
      }
    })
    const work = bounded(current.connect(), current, timeoutSetting('REDIS_CONNECT_TIMEOUT_MS', 1000)).then(() => current)
    connecting = work
    try { return await work }
    catch (error) { discard(current); throw error }
    finally { if (connecting === work) connecting = undefined }
  }
  return {
    async run<T>(command: (connection: RedisConnection) => Promise<T>, timeoutMs = commandTimeoutMs): Promise<T> {
      let current: RedisConnection | undefined
      let expired = false
      const deadline = Date.now() + timeoutMs
      // Include connection setup in the caller's total budget (health checks in
      // particular must not hang before their PING timeout starts).
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([(async () => {
          current = await ready()
          // A caller may have timed out while sharing another caller's connect.
          // Do not run SET/GETDEL after that caller has already returned failure.
          if (expired || Date.now() >= deadline) throw new Error('REDIS_TIMEOUT')
          return bounded(command(current), current, Math.max(1, deadline - Date.now()))
        })(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error('REDIS_TIMEOUT')) }, timeoutMs)
        })])
      } catch (error) { if (current) discard(current); throw error }
      finally { if (timer) clearTimeout(timer) }
    },
  }
}

const access = createRedisAccess()

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
    const count = (await access.run(client => client.eval(
      "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return current",
      { keys: [`rate:${key}`], arguments: [String(seconds)] },
    ))) as number
    return count > max
  } catch {
    // Redis is down: fall back to the local window instead of waving the request through.
    return limitedLocally(key, max, seconds)
  }
}

/** Bootstrap liveness probe. True when Redis answers PING, false otherwise. Never throws. */
export async function redisPing(timeoutMs = 2000): Promise<boolean> {
  try {
    await access.run(client => client.ping(), timeoutMs)
    return true
  } catch {
    return false
  }
}

export async function redisSet(key: string, value: object, ttlSeconds: number): Promise<void> {
  await access.run(client => client.set(key, JSON.stringify(value), { EX: ttlSeconds }))
}

export async function redisGetDel<T>(key: string): Promise<T | null> {
  const raw = await access.run(client => client.getDel(key))
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
