/**
 * Optional, single-batch Outbox history pruning. Defaults to a read-only dry run.
 * Run from the repository root with DATABASE_URL already set (no .env loading):
 * pnpm --filter @musecanvas/database exec tsx ../../scripts/prune-outbox.ts --days=30 --limit=1000
 * Add --execute only after reviewing the dry run and taking the required backup.
 * Deletion is irreversible without restoring a backup. Never scheduled by Worker.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../packages/database/src/index'

export interface PruneOutboxOptions { days: number; limit: number; execute: boolean }
export interface PruneOutboxClient {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ count: number | string }> }>
}

function validate(options: PruneOutboxOptions): void {
  if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 36500
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10000
    || typeof options.execute !== 'boolean') throw new Error('INVALID_OUTBOX_RETENTION_OPTIONS')
}

export function parsePruneArgs(args: string[]): PruneOutboxOptions {
  const options: PruneOutboxOptions = { days: 30, limit: 1000, execute: false }
  const seen = new Set<string>()
  for (const argument of args) {
    const match = /^--(days|limit)=(\d+)$/.exec(argument)
    const key = match ? match[1] : argument === '--execute' || argument === '--dry-run' ? 'mode' : ''
    if (!key || seen.has(key)) throw new Error('INVALID_OUTBOX_RETENTION_ARGUMENTS')
    seen.add(key)
    if (match) options[match[1] as 'days' | 'limit'] = Number(match[2])
    else options.execute = argument === '--execute'
  }
  validate(options)
  return options
}

/** No connections, environment access, or logging: the caller supplies its client. */
export async function pruneOutbox(client: PruneOutboxClient, options: PruneOutboxOptions): Promise<{ eligible: number; deleted: number }> {
  validate(options)
  const predicate = `dispatched_at < now()-($1*interval '1 day') AND dispatch_token IS NULL
    AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at <= now())`
  if (!options.execute) {
    const result = await client.query(
      `SELECT count(*)::int AS count FROM (
        SELECT id FROM outbox_events WHERE ${predicate} ORDER BY dispatched_at,id LIMIT $2
      ) candidates`, [options.days, options.limit],
    )
    return { eligible: Number(result.rows[0]?.count || 0), deleted: 0 }
  }
  // One statement holds locks only while deleting this batch. Pending events,
  // active claims, and leased rows remain ineligible regardless of creation age.
  const result = await client.query(
    `WITH candidates AS (
      SELECT id FROM outbox_events WHERE ${predicate}
      ORDER BY dispatched_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM outbox_events e USING candidates c WHERE e.id=c.id RETURNING e.id
    ) SELECT count(*)::int AS count FROM removed`, [options.days, options.limit],
  )
  const deleted = Number(result.rows[0]?.count || 0)
  return { eligible: deleted, deleted }
}

async function main(): Promise<void> {
  let pool: ReturnType<typeof db> | undefined
  try {
    const options = parsePruneArgs(process.argv.slice(2))
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')
    pool = db()
    console.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', ...await pruneOutbox(pool, options) }))
  } catch {
    // Database error messages can contain connection information. Only emit a code.
    console.error('outbox pruning failed', { code: 'OUTBOX_PRUNE_FAILED' })
    process.exitCode = 1
  } finally { if (pool) await pool.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
