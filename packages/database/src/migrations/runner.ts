import type pg from 'pg'

import {
  BASELINE_MAX_VERSION,
  loadMigrations,
  migrationsDirUrl,
  type MigrationFile,
} from './loader'

/**
 * Sequential migration runner.
 *
 * Execution model: one dedicated connection holds a session advisory lock for the
 * whole run, so several API/worker/compose instances racing to migrate converge on
 * a single executor instead of deadlocking on identical DDL. Each migration file
 * is then applied inside its own transaction and recorded, so a crash leaves the
 * unrecorded file to be retried rather than wedging the next deploy.
 */

/** Namespace for the migration lock. Two ints keeps this per-database. */
export const ADVISORY_LOCK_CLASSID = 7265157
export const ADVISORY_LOCK_OBJID = 1

/** How long a second runner waits for the lock before failing loudly. */
export const LOCK_TIMEOUT = '900s'
const APPLICATION_NAME = 'musecanvas-db-migrate'

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY,
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'sequential'
              CHECK (kind IN ('baseline','sequential')),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
)`

export type MigrateEvent =
  | { type: 'start'; database: string; user: string; server: string; pending: number; total: number }
  | { type: 'legacy'; maxVersion: string }
  | { type: 'applied'; version: string; name: string; durationMs: number }
  | { type: 'skipped'; version: string; name: string; reason: 'recorded' | 'dry-run' }
  | { type: 'waiting' }
  | { type: 'warn'; code: WarnCode; message: string }

export type WarnCode = 'CHECKSUM_DIFFERS_BASELINE' | 'ORPHAN_ROW' | 'UNKNOWN_MIGRATION_FILE'

export type MigrateResult = {
  applied: string[]
  skipped: string[]
  latest: string | null
  database: string
}

export type MigrateOptions = {
  pool: pg.Pool
  /** Defaults to packages/database/migrations, resolved from this module. */
  dir?: string | URL
  dryRun?: boolean
  onEvent?: (event: MigrateEvent) => void
  /**
   * Version up to which history/checksum differences are tolerated rather than
   * fatal, because those files were historically applied from bytes predating the
   * split. Defaults to the real baseline; overridable so the strict branches are
   * testable against a small fixture directory.
   */
  baselineMaxVersion?: string
}

export class MigrationValidationError extends Error {}

type Row = Record<string, unknown>

/**
 * Bring the database up to the latest migration. Throws on a failed migration or
 * on a history/file disagreement that could silently skip schema; returns a result
 * describing what happened otherwise. Never closes the pool it is given — the
 * caller must release the connection first and only then end the pool, or
 * `pool.end()` waits forever on a checked-out client.
 */
export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const { pool, dir = migrationsDirUrl(), dryRun = false, onEvent, baselineMaxVersion = BASELINE_MAX_VERSION } = options
  const migrations = loadMigrations(dir)
  const emit = (event: MigrateEvent) => onEvent?.(event)

  const client = await pool.connect()
  try {
    await client.query(`SET application_name = '${APPLICATION_NAME}'`)
    // 0014's cursor over model_configs must not be killed by a server default.
    await client.query('SET statement_timeout = 0')
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`)

    emit({ type: 'waiting' })
    // Session-scoped on purpose: an xact lock would release at the first COMMIT and
    // leave every later migration unserialized.
    await client.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_CLASSID, ADVISORY_LOCK_OBJID])

    const identity = await client.query(
      'SELECT current_database() AS database, current_user AS "user", version() AS server',
    )
    const who = (identity.rows?.[0] ?? {}) as Row
    const database = String(who.database ?? 'unknown')
    const user = String(who.user ?? 'unknown')
    const server = String(who.server ?? 'unknown')

    // After the lock, so two runners never race on the DDL itself.
    await client.query(HISTORY_DDL)

    const recorded = new Map<string, { checksum: string; kind: string }>()
    const history = await client.query('SELECT version, checksum, kind FROM schema_migrations')
    for (const row of (history.rows ?? []) as Row[]) {
      recorded.set(String(row.version), { checksum: String(row.checksum), kind: String(row.kind) })
    }

    const knownVersions = new Set(migrations.map(migration => migration.version))
    validate({ migrations, recorded, knownVersions, emit, baselineMaxVersion })

    const isLegacy = recorded.size === 0 && await tableExists(client, 'users')
    if (isLegacy) {
      // Classify only: every migration still runs, because a legacy database may
      // have stopped at any point in the historical stream and stamping would
      // permanently hide whichever objects it never reached.
      emit({ type: 'legacy', maxVersion: baselineMaxVersion })
    }

    const pending = migrations.filter(migration => !recorded.has(migration.version))
    emit({ type: 'start', database, user, server, pending: pending.length, total: migrations.length })

    const applied: string[] = []
    const skipped: string[] = []
    for (const migration of migrations) {
      if (recorded.has(migration.version)) {
        skipped.push(migration.version)
        emit({ type: 'skipped', version: migration.version, name: migration.name, reason: 'recorded' })
        continue
      }
      if (dryRun) {
        skipped.push(migration.version)
        emit({ type: 'skipped', version: migration.version, name: migration.name, reason: 'dry-run' })
        continue
      }
      const durationMs = await apply(client, migration, isLegacy ? 'baseline' : 'sequential')
      applied.push(migration.version)
      emit({ type: 'applied', version: migration.version, name: migration.name, durationMs })
    }

    return {
      applied,
      skipped,
      latest: migrations.length ? migrations[migrations.length - 1].version : null,
      database,
    }
  } finally {
    // Swallow an unlock failure: a connection already broken by a failed migration
    // must not mask the original error, and an unreleased client would hang the
    // caller's pool.end() forever.
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_CLASSID, ADVISORY_LOCK_OBJID])
    } catch {
      /* the session ends with the connection, which releases the lock */
    }
    client.release()
  }
}

async function tableExists(client: pg.PoolClient, table: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS oid', [`public.${table}`])
  return (result.rows?.[0] as Row | undefined)?.oid != null
}

function validate(input: {
  migrations: MigrationFile[]
  recorded: Map<string, { checksum: string; kind: string }>
  knownVersions: Set<string>
  emit: (event: MigrateEvent) => void
  baselineMaxVersion: string
}): void {
  const { migrations, recorded, knownVersions, emit, baselineMaxVersion } = input
  const maxRecorded = [...recorded.keys()].sort().at(-1)

  for (const version of recorded.keys()) {
    if (knownVersions.has(version)) continue
    if (version > baselineMaxVersion) {
      throw new MigrationValidationError(
        `schema_migrations records ${version} but no such migration file exists; applied migrations must never be deleted or renamed`,
      )
    }
    emit({ type: 'warn', code: 'ORPHAN_ROW', message: `schema_migrations records ${version}, which has no file on disk (pre-split baseline)` })
  }

  for (const migration of migrations) {
    const entry = recorded.get(migration.version)
    if (entry && entry.checksum !== migration.checksum) {
      if (migration.version > baselineMaxVersion) {
        throw new MigrationValidationError(
          `migration ${migration.filename} changed after it was applied (recorded ${entry.checksum.slice(0, 12)}, found ${migration.checksum.slice(0, 12)}); add a new migration instead of editing an applied one`,
        )
      }
      // The baseline files were historically applied from bytes that predate the
      // split, so a mismatch there is expected and must not brick the deploy.
      emit({ type: 'warn', code: 'CHECKSUM_DIFFERS_BASELINE', message: `${migration.filename} differs from the recorded baseline checksum` })
    }
    if (!entry && maxRecorded && migration.version < maxRecorded) {
      throw new MigrationValidationError(
        `migration ${migration.filename} is out of order: ${maxRecorded} is already applied. Branching merges must renumber, not backfill.`,
      )
    }
  }
}

async function apply(
  client: pg.PoolClient,
  migration: MigrationFile,
  kind: 'baseline' | 'sequential',
): Promise<number> {
  const started = Date.now()
  const elapsed = () => Date.now() - started

  if (!migration.transactional) {
    // Its own implicit transaction, matching the historical standalone ALTER TYPE.
    // A crash between applying and recording is self-healing: the statement is
    // `IF NOT EXISTS`, so the retry re-runs it (a notice) and records it.
    await client.query(migration.sql)
    await record(client, migration, kind, elapsed())
    return elapsed()
  }

  await client.query('BEGIN')
  try {
    // The whole file goes over as one simple query, so Postgres wraps every
    // statement in it in this one transaction. Never split on `;` here: that
    // would sever the DO $$ ... $$; bodies.
    await client.query(migration.sql)
    await record(client, migration, kind, elapsed())
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* report the original failure, not the cleanup one */
    }
    const detail = error && typeof error === 'object' ? (error as { message?: string; code?: string }) : {}
    throw new Error(`migration ${migration.filename} failed${detail.code ? ` [${detail.code}]` : ''}: ${detail.message ?? String(error)}`)
  }
  return elapsed()
}

async function record(
  client: pg.PoolClient,
  migration: MigrationFile,
  kind: 'baseline' | 'sequential',
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations(version, name, checksum, kind, duration_ms)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.name, migration.checksum, kind, Math.round(durationMs)],
  )
}
