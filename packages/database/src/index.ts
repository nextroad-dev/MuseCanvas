import pg from 'pg'

const { Pool } = pg
let singleton: pg.Pool | undefined

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Each timeout is per connection/query; total pool size still scales with replicas. */
export function poolConfig(): pg.PoolConfig {
  return {
    connectionString: process.env.DATABASE_URL,
    max: positiveInt('DATABASE_POOL_MAX', 12),
    connectionTimeoutMillis: positiveInt('DATABASE_CONNECTION_TIMEOUT_MS', 5000),
    idleTimeoutMillis: positiveInt('DATABASE_IDLE_TIMEOUT_MS', 30000),
    statement_timeout: positiveInt('DATABASE_STATEMENT_TIMEOUT_MS', 30000),
    lock_timeout: positiveInt('DATABASE_LOCK_TIMEOUT_MS', 5000),
    idle_in_transaction_session_timeout: positiveInt('DATABASE_IDLE_TRANSACTION_TIMEOUT_MS', 30000),
  }
}

export function db(): pg.Pool {
  if (!singleton) {
    singleton = new Pool(poolConfig())
    // Idle connection errors are emitted outside query try/catch. Never log
    // upstream messages: they may contain connection details or SQL values.
    singleton.on('error', () => console.error('database idle connection error', { code: 'DATABASE_POOL_ERROR' }))
  }
  return singleton
}
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect()
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export * from './repositories/model-config-revisions'
export * from './repositories/provider-runs'
export * from './repositories/output-ingestions'
export * from './repositories/onboarding'
export * from './repositories/prompt-templates'
export * from './repositories/provider-credentials'
export * from './repositories/canvas-documents'
export * from './repositories/canvas-agent'

export * from './repositories/canvas-agent-preparations'
