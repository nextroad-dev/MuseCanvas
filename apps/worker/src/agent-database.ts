import type { AgentCoreClient, AgentCoreTransaction } from '@musecanvas/database'
import type { AgentModelQuery } from './agent/model'
import type { AgentSqlClient, AgentTransaction } from './agent/ports'

export interface AgentDatabaseClient extends AgentCoreClient {
  release(destroy?: boolean): void
}
export interface AgentDatabasePool { connect(): Promise<AgentDatabaseClient> }

function aborted(): Error { return new Error('AGENT_DATABASE_CANCELED') }

/** Acquiring a pool slot may outlive cancellation; release any late connection. */
async function acquire(pool: AgentDatabasePool, signal: AbortSignal): Promise<AgentDatabaseClient> {
  if (signal.aborted) throw aborted()
  return new Promise((resolve, reject) => {
    let finished = false
    const onAbort = () => { finished = true; reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
    void pool.connect().then(client => {
      signal.removeEventListener('abort', onAbort)
      if (finished || signal.aborted) { client.release(); return }
      finished = true
      resolve(client)
    }, () => {
      signal.removeEventListener('abort', onAbort)
      if (!finished) { finished = true; reject(new Error('AGENT_DATABASE_UNAVAILABLE')) }
    })
  })
}

const sqlClient = (client: AgentCoreClient): AgentSqlClient => ({
  query: async (text, values) => {
    const result = await client.query<Record<string, unknown>>(text, values)
    return { rows: result.rows, rowCount: result.rowCount }
  },
})

/** No connections are opened at construction. All clients are released before return. */
export function createAgentDatabasePorts(pool: AgentDatabasePool, statementTimeoutMs = 30_000) {
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > 120_000) {
    throw new Error('AGENT_DATABASE_INVALID_TIMEOUT')
  }
  const core: AgentCoreTransaction = async (work, readOnly = false) => {
    const signal = AbortSignal.timeout(statementTimeoutMs)
    const client = await acquire(pool, signal)
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [String(statementTimeoutMs), String(Math.min(statementTimeoutMs, 5000))])
      const result = await work(client)
      if (signal.aborted) throw aborted()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release(signal.aborted) }
  }
  const read: AgentCoreTransaction = work => core(work, true)
  const transaction: AgentTransaction = work => core(client => work(sqlClient(client)))
  const readTransaction: AgentTransaction = work => core(client => work(sqlClient(client)), true)

  const modelQuery: AgentModelQuery = async (text, values, options) => {
    const budget = Math.max(1, Math.min(statementTimeoutMs, options?.timeoutMs ?? statementTimeoutMs))
    const signal = AbortSignal.any([AbortSignal.timeout(budget), ...(options ? [options.signal] : [])])
    const started = Date.now()
    const client = await acquire(pool, signal)
    let released = false
    const release = (destroy: boolean) => {
      if (!released) { released = true; client.release(destroy) }
    }
    const onAbort = () => release(true)
    signal.addEventListener('abort', onAbort, { once: true })
    const run = (text: string, values: unknown[] = []) => {
      if (signal.aborted) { release(true); return Promise.reject(aborted()) }
      const remaining = Math.max(1, budget - (Date.now() - started))
      const query = { text, values, query_timeout: remaining }
      return new Promise<{ rows: Record<string, unknown>[] }>((resolve, reject) => {
        const cancel = () => { release(true); reject(aborted()) }
        signal.addEventListener('abort', cancel, { once: true })
        // Observe late success and failure even after cancellation destroys the client.
        void client.query<Record<string, unknown>>(query).then(result => {
          signal.removeEventListener('abort', cancel)
          if (signal.aborted) reject(aborted())
          else resolve({ rows: result.rows })
        }, error => {
          signal.removeEventListener('abort', cancel)
          // A driver timeout does not prove the server stopped its statement.
          release(true)
          reject(error)
        })
      })
    }
    try {
      await run('BEGIN READ ONLY')
      const remaining = Math.max(1, budget - (Date.now() - started))
      await run("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [String(remaining), String(Math.min(remaining, 5000))])
      const result = await run(text, [...values])
      await run('COMMIT')
      return result
    } catch (error) {
      if (!released && !signal.aborted) await run('ROLLBACK').catch(() => {})
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      release(signal.aborted)
    }
  }
  return { core, read, transaction, readTransaction, modelQuery }
}
