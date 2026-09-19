import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'

import { loadMigrations } from './loader'
import {
  ADVISORY_LOCK_CLASSID,
  ADVISORY_LOCK_OBJID,
  MigrationValidationError,
  runMigrations,
  type MigrateEvent,
} from './runner'

/**
 * Control-flow tests for the runner, using the repository's existing convention
 * of a duck-typed query client (`repositories.test.ts`, `backend.test.ts`).
 *
 * Scope, stated plainly: these prove what statements the runner sends, in what
 * order, inside what transaction boundaries, and how it reacts to a failure or a
 * disagreeing history table. They cannot prove PostgreSQL's own behaviour — that
 * rollback actually discards, that the advisory lock actually serializes, that a
 * legacy database actually converges. `runner.db.test.ts` covers those against a
 * real server and skips unless TEST_DATABASE_URL is set.
 */

type HistoryRow = { version: string; name: string; checksum: string; kind: string }
type Call = { sql: string; params?: unknown[] }

function createFakeDb(init: { history?: HistoryRow[]; tables?: string[] } = {}) {
  const history: HistoryRow[] = (init.history ?? []).map(row => ({ ...row }))
  const tables = new Set<string>(init.tables ?? [])
  const markers: string[] = []
  const calls: Call[] = []
  let journal: Array<() => void> = []
  let inTx = false
  let releases = 0

  const bufferWrite = (write: () => void) => {
    if (inTx) journal.push(write)
    else write()
  }

  const client = {
    async query(sql: string, params?: unknown[]) {
      const text = sql.trim()
      calls.push({ sql: text, params })

      if (/^BEGIN$/i.test(text)) { inTx = true; journal = []; return { rows: [] } }
      if (/^COMMIT$/i.test(text)) {
        const pending = journal
        journal = []
        inTx = false
        pending.forEach(write => write())
        return { rows: [] }
      }
      if (/^ROLLBACK$/i.test(text)) { journal = []; inTx = false; return { rows: [] } }
      if (/^SET\b/i.test(text)) return { rows: [] }
      if (/^SELECT pg_advisory_(un)?lock/i.test(text)) return { rows: [{ v: null }] }
      if (/current_database\(\)/i.test(text)) {
        return { rows: [{ database: 'musecanvas_migtest', user: 'musecanvas', server: 'PostgreSQL 17.0 on x86_64' }] }
      }
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) return { rows: [] }
      if (/^SELECT version, checksum, kind FROM schema_migrations/i.test(text)) {
        return { rows: history.map(row => ({ ...row })) }
      }
      if (/to_regclass/i.test(text)) {
        const name = String(params?.[0] ?? '').replace(/^public\./, '')
        return { rows: [{ oid: tables.has(name) ? '16384' : null }] }
      }
      if (/^INSERT INTO schema_migrations/i.test(text)) {
        const [version, name, checksum, kind] = params as string[]
        bufferWrite(() => {
          if (!history.some(row => row.version === version)) history.push({ version, name, checksum, kind })
        })
        return { rows: [] }
      }

      // Anything else is a migration body. Track its writes through the journal so
      // a rollback genuinely discards them, then optionally fail.
      for (const match of text.matchAll(/INSERT INTO mig_marker\(k\) VALUES\('([a-z]+)'\)/g)) {
        const key = match[1]
        bufferWrite(() => { if (!markers.includes(key)) markers.push(key) })
      }
      for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) tables.add(match[1])
      if (/RAISE EXCEPTION/.test(text)) {
        throw Object.assign(new Error('injected failure'), { code: 'P0001' })
      }
      return { rows: [] }
    },
    release() { releases += 1 },
  }

  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    calls,
    history,
    markers,
    tables,
    released: () => releases,
    sqlOf: (needle: string) => calls.filter(call => call.sql.includes(needle)).map(call => call.sql),
  }
}

function collect() {
  const events: MigrateEvent[] = []
  return { events, onEvent: (event: MigrateEvent) => { events.push(event) } }
}

const FIXTURE_DIR = new URL('../../testdata/migrations/', import.meta.url)

test('a fresh database applies every migration in order and records each one', async () => {
  const db = createFakeDb()
  const { events, onEvent } = collect()
  const total = loadMigrations().length

  const result = await runMigrations({ pool: db.pool, onEvent })

  assert.equal(result.applied.length, total)
  assert.equal(result.skipped.length, 0)
  assert.equal(result.latest, total.toString().padStart(4, '0'))
  assert.equal(result.database, 'musecanvas_migtest')
  assert.equal(db.history.length, total)
  assert.deepEqual(db.history.map(row => row.version), loadMigrations().map(migration => migration.version))
  assert.deepEqual([...new Set(db.history.map(row => row.kind))], ['sequential'])

  // The lock is taken once, with the documented key, and released.
  const lock = db.calls.find(call => /pg_advisory_lock/.test(call.sql))
  assert.deepEqual(lock?.params, [ADVISORY_LOCK_CLASSID, ADVISORY_LOCK_OBJID])
  assert.ok(db.calls.some(call => /pg_advisory_unlock/.test(call.sql)))
  assert.equal(
    db.calls.some(call => /pg_advisory_xact_lock/.test(call.sql)),
    false,
    'a transaction-scoped lock would release at the first COMMIT and leave later migrations unserialized',
  )
  assert.equal(db.released(), 1, 'the checked-out client must always be released, or pool.end() hangs')

  // Every operator needs to see which database they are about to change.
  const start = events.find(event => event.type === 'start')
  assert.ok(start && start.type === 'start')
  assert.equal(start.database, 'musecanvas_migtest')
  assert.equal(start.pending, total)
})

test('a second run is a no-op and re-sends no migration SQL', async () => {
  const db = createFakeDb()
  const first = await runMigrations({ pool: db.pool })
  const callsAfterFirst = db.calls.length
  const usersDdl = db.sqlOf('CREATE TABLE IF NOT EXISTS users').length

  const second = await runMigrations({ pool: db.pool })

  assert.deepEqual(second.applied, [])
  assert.equal(second.skipped.length, first.applied.length)
  assert.equal(db.history.length, first.applied.length, 're-running must not duplicate history rows')
  assert.equal(db.sqlOf('CREATE TABLE IF NOT EXISTS users').length, usersDdl, 'migration bodies must not be re-sent')
  assert.equal(db.calls.slice(callsAfterFirst).some(call => /INSERT INTO schema_migrations/.test(call.sql)), false)
})

test('a database created by the historical script is classified as baseline and still replayed', async () => {
  const db = createFakeDb({ tables: ['users'] })
  const { events, onEvent } = collect()

  const result = await runMigrations({ pool: db.pool, onEvent })

  assert.ok(events.some(event => event.type === 'legacy'), 'the operator must be told a replay is about to happen')
  assert.ok(result.applied.length > 20, 'classifying as legacy must not skip work')
  assert.deepEqual([...new Set(db.history.map(row => row.kind))], ['baseline'])
})

test('only the enum migration escapes the per-file transaction', async () => {
  const db = createFakeDb()
  await runMigrations({ pool: db.pool })

  const index = db.calls.findIndex(call => /ADD VALUE/.test(call.sql))
  assert.ok(index > 0)
  assert.match(db.calls[index].sql, /ALTER TYPE model_adapter/)
  assert.notEqual(db.calls[index - 1].sql, 'BEGIN', 'ADD VALUE must run in its own already-committed transaction')
  assert.equal(db.calls[index + 1].sql.startsWith('INSERT INTO schema_migrations'), true)

  // Migration files open with a comment header, so match on content, and check
  // the call *before* the body to see whether a transaction wrapped it.
  const transactional = db.calls.findIndex(call => call.sql.includes('CREATE TABLE IF NOT EXISTS users ('))
  assert.ok(transactional > 0, 'expected the users baseline table to be created')
  assert.equal(db.calls[transactional - 1].sql, 'BEGIN')
  assert.ok(db.calls.slice(transactional, transactional + 5).some(call => call.sql === 'COMMIT'))
})

test('a failing migration rolls back its own file and stops the run', async () => {
  const db = createFakeDb()
  const before = db.calls.length

  await assert.rejects(
    () => runMigrations({ pool: db.pool, dir: FIXTURE_DIR }),
    /0003_boom\.sql failed \[P0001\]: injected failure/,
  )

  // 0001 and 0002 committed; 0003's write is discarded with its transaction;
  // 0004 never started.
  assert.deepEqual(db.markers, ['alpha', 'beta'], 'a rolled-back migration must leave no row behind')
  assert.deepEqual(db.history.map(row => row.version), ['0001', '0002'])
  assert.equal(db.sqlOf("'delta'").length, 0, 'migrations after the failure must not run')
  assert.ok(db.calls.slice(before).some(call => call.sql === 'ROLLBACK'))
  assert.ok(db.calls.some(call => /pg_advisory_unlock/.test(call.sql)), 'the lock must be released on the failure path')
  assert.equal(db.released(), 1)
})

test('a recorded migration whose file has vanished is a hard failure', async () => {
  const db = createFakeDb({ history: [{ version: '0027', name: 'invented', checksum: 'x'.repeat(64), kind: 'sequential' }] })
  const error = await runMigrations({ pool: db.pool }).catch((caught: unknown) => caught)
  assert.ok(error instanceof MigrationValidationError, 'a deleted applied migration must refuse to boot')
  assert.match(error.message, /must never be deleted or renamed/)
  assert.equal(db.released(), 1, 'the connection must be returned even when validation fails')
})

test('an applied migration whose bytes changed is fatal past the baseline, tolerated inside it', async () => {
  const [first] = loadMigrations()
  const tampered = [{ version: first.version, name: first.name, checksum: 'deadbeef', kind: 'sequential' }]

  // Past the baseline: refuse to boot rather than trust a rewritten history.
  await assert.rejects(
    () => runMigrations({ pool: createFakeDb({ history: tampered }).pool, dir: FIXTURE_DIR, baselineMaxVersion: '0000' }),
    /changed after it was applied/,
  )

  // Inside the baseline: the historical bytes predate the split, so warn and go on.
  const db = createFakeDb({ history: tampered })
  const { events, onEvent } = collect()
  const result = await runMigrations({ pool: db.pool, onEvent })
  assert.ok(events.some(event => event.type === 'warn' && event.code === 'CHECKSUM_DIFFERS_BASELINE'))
  assert.equal(result.applied.length, loadMigrations().length - 1)
})

test('a migration that sorts before an applied one is refused', async () => {
  const migrations = loadMigrations(FIXTURE_DIR)
  const applied = migrations.slice(0, 3).map(migration => ({
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    kind: 'sequential',
  }))
  // Record 0003 only: 0001/0002 are then "out of order" behind it.
  await assert.rejects(
    () => runMigrations({ pool: createFakeDb({ history: [applied[2]] }).pool, dir: FIXTURE_DIR, baselineMaxVersion: '0000' }),
    /is out of order/,
  )
})

test('dry run reports what it would do and changes nothing', async () => {
  const db = createFakeDb()
  const total = loadMigrations().length

  const result = await runMigrations({ pool: db.pool, dryRun: true })

  assert.deepEqual(result.applied, [])
  assert.equal(result.skipped.length, total)
  assert.equal(db.history.length, 0)
  assert.equal(db.sqlOf('CREATE TABLE IF NOT EXISTS users').length, 0)
  assert.ok(db.calls.some(call => /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(call.sql)), 'the history table must still be inspected')
  assert.equal(db.released(), 1)
})
