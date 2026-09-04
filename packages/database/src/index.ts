import pg from 'pg'

const { Pool } = pg
let singleton: pg.Pool | undefined
export function db(): pg.Pool {
  singleton ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
  return singleton
}
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect()
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export * from './transactions/billing'
export * from './repositories/model-config-revisions'
export * from './repositories/provider-runs'
export * from './repositories/output-ingestions'
export * from './repositories/onboarding'
export * from './repositories/prompt-templates'
