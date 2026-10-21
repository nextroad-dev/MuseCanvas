import {
  SETUP_DATABASE_DRIVERS,
  type DatabaseConnectionSummary,
  type SetupDatabaseStatus,
} from '@musecanvas/contracts'

// Pure shaping of the setup database report. Nothing here touches the network or the
// environment beyond the URL string it is given, so the no-credential rule is testable.

export const DATABASE_PROBE_TIMEOUT_MS = 3000
const DEFAULT_POSTGRES_PORT = 5432

/** Everything the probe learned. `connection` is null when the URL could not be parsed. */
export interface DatabaseProbeFacts {
  connection: DatabaseConnectionSummary | null
  reachable: boolean
  serverVersion: string | null
  schemaVersion: string | null
}

function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Non-secret summary of a postgres URL. The password, the query string and the raw
 * URL are never copied out. Returns null when the URL is missing, unparseable, or not
 * a postgres URL. The caller then reports the database as unreachable without probing.
 */
export function parseDatabaseConnection(rawUrl: string | undefined): DatabaseConnectionSummary | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null
  const host = url.hostname ? decodeOrRaw(url.hostname) : null
  const database = decodeOrRaw(url.pathname.replace(/^\//, '')) || null
  const user = decodeOrRaw(url.username) || null
  const port = host === null ? null : url.port ? Number(url.port) : DEFAULT_POSTGRES_PORT
  return { host, port, database, user }
}

/**
 * The wire DTO. Server version and schema version are reported only for a reachable
 * database, so a stale value never appears next to `reachable: false`.
 */
export function shapeDatabaseStatus(facts: DatabaseProbeFacts): SetupDatabaseStatus {
  const reachable = facts.connection !== null && facts.reachable
  return {
    driver: 'postgres',
    availableDrivers: SETUP_DATABASE_DRIVERS.map(driver => ({ ...driver })),
    connection: facts.connection ?? { host: null, port: null, database: null, user: null },
    serverVersion: reachable ? facts.serverVersion : null,
    schemaVersion: reachable ? facts.schemaVersion : null,
    reachable,
  }
}
