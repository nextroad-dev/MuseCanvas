import { createClient } from 'redis'

let redis: ReturnType<typeof createClient> | undefined

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
    return false
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