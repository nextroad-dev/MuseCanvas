import type { NextRequest, NextResponse } from 'next/server'
import { db } from '@musecanvas/database'
import type { SetupDatabaseStatus } from '@musecanvas/contracts'
import { clientIpFromRequest, fail, ok } from '../../shared/http'
import { limited } from '../../shared/redis'
import { requireSetupAccess } from './access'
import {
  DATABASE_PROBE_TIMEOUT_MS,
  parseDatabaseConnection,
  shapeDatabaseStatus,
  type DatabaseProbeFacts,
} from './database-status'

/** Test attempts per client address per window. Mirrors the other setup write probes. */
const DATABASE_TEST_LIMIT = 10
const DATABASE_TEST_WINDOW_SECONDS = 600

/** Success carries the status DTO. A failed probe sets `errorCode` and never the driver's message. */
export type SetupDatabaseTestResult = SetupDatabaseStatus & {
  ok: boolean
  errorCode: 'DATABASE_UNREACHABLE' | null
}

function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DATABASE_PROBE_TIMEOUT')), ms)
  })
  return Promise.race([Promise.resolve().then(task), expired]).finally(() => clearTimeout(timer))
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

async function probeFacts(): Promise<DatabaseProbeFacts> {
  const connection = parseDatabaseConnection(process.env.DATABASE_URL)
  if (!connection) return { connection: null, reachable: false, serverVersion: null, schemaVersion: null }
  try {
    await withTimeout(() => db().query('SELECT 1'), DATABASE_PROBE_TIMEOUT_MS)
  } catch {
    return { connection, reachable: false, serverVersion: null, schemaVersion: null }
  }
  // Both reads are best-effort: a missing schema_migrations table (fresh database) is not an error.
  const serverVersion = await withTimeout(() => db().query('SHOW server_version'), DATABASE_PROBE_TIMEOUT_MS)
    .then(result => text(result.rows[0]?.server_version), (): null => null)
  const schemaVersion = await withTimeout(() => db().query('SELECT max(version) AS version FROM schema_migrations'), DATABASE_PROBE_TIMEOUT_MS)
    .then(result => text(result.rows[0]?.version), (): null => null)
  return { connection, reachable: true, serverVersion, schemaVersion }
}

/** Current database report. Never throws for an unreachable or misconfigured database. */
export async function probeSetupDatabase(): Promise<SetupDatabaseStatus> {
  return shapeDatabaseStatus(await probeFacts())
}

export async function setupDatabaseStatus(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  return ok(await probeSetupDatabase())
}

export async function setupDatabaseTest(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  if (await limited(`setup-database-test:${clientIpFromRequest(request)}`, DATABASE_TEST_LIMIT, DATABASE_TEST_WINDOW_SECONDS)) {
    return fail('RATE_LIMITED', '测试尝试过多，请稍后再试', 429)
  }
  const status = await probeSetupDatabase()
  const result: SetupDatabaseTestResult = {
    ...status,
    ok: status.reachable,
    errorCode: status.reachable ? null : 'DATABASE_UNREACHABLE',
  }
  return ok(result)
}
