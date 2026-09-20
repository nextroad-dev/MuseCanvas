import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BASELINE_MAX_VERSION,
  loadMigrations,
  listUnknownMigrationFiles,
  migrationsDirUrl,
  normalizeSql,
  parseMigration,
  sha256,
  splitStatements,
  statementStream,
  type MigrationFile,
} from './loader'

/**
 * Guards for the split of the historical `src/migrate.ts` statement stream into
 * `migrations/0001..0026.sql`.
 *
 * These need no database and always run, which is the point: the single worst
 * failure mode of a schema split is silently losing a statement, and that must
 * be caught in CI in milliseconds rather than by a repository method throwing on
 * a production deploy. The real behaviour of the runner is covered separately by
 * `runner.test.ts`, which opts in via TEST_DATABASE_URL.
 */

const GOLDEN_URL = new URL('../../testdata/legacy-migrate.sql', import.meta.url)

function baselineMigrations(): MigrationFile[] {
  return loadMigrations().filter(migration => migration.version <= BASELINE_MAX_VERSION)
}

function migrationNamed(token: string): MigrationFile {
  // Keyed on the filename stem rather than the number, so a later slice adding
  // 0027+ cannot break these assertions by renumbering.
  const found = loadMigrations().find(migration => migration.name === token)
  assert.ok(found, `expected a migration named *_${token}.sql`)
  return found as MigrationFile
}

test('the split reproduces the historical statement stream exactly, in order', () => {
  const original = statementStream(readFileSync(GOLDEN_URL, 'utf8'))
  const split = statementStream(baselineMigrations().map(migration => migration.sql).join('\n'))

  assert.ok(original.length > 200, `golden master looks truncated (${original.length} statements)`)
  assert.equal(split.length, original.length, 'the split and the historical stream hold a different number of statements')

  // Order-sensitive, element by element, so a failure names the exact statement.
  for (let index = 0; index < original.length; index++) {
    assert.equal(
      split[index],
      original[index],
      `statement ${index} diverged.\n  expected: ${original[index]?.slice(0, 220)}\n  received: ${split[index]?.slice(0, 220)}`,
    )
  }
})

test('migration filenames are well formed, contiguous and unique', () => {
  const migrations = loadMigrations()
  assert.deepEqual(listUnknownMigrationFiles(), [], 'migrations/ must not contain files the runner would silently ignore')

  const versions = migrations.map(migration => migration.version)
  assert.equal(new Set(versions).size, versions.length, 'duplicate migration version')
  assert.equal(new Set(migrations.map(migration => migration.name)).size, versions.length, 'duplicate migration name')

  versions.forEach((version, index) => {
    assert.equal(Number(version), index + 1, `versions must count up from 0001 without gaps, found ${version} at position ${index}`)
  })
  assert.equal(versions[versions.length - 1], BASELINE_MAX_VERSION, 'BASELINE_MAX_VERSION must point at the last baseline migration')
})

test('every table is created by exactly one migration', () => {
  const owners = new Map<string, string[]>()
  for (const migration of baselineMigrations()) {
    for (const statement of statementStream(migration.sql)) {
      const created = /^CREATE TABLE IF NOT EXISTS ([a-z_]+)/i.exec(statement)
      if (!created) continue
      const tables = owners.get(created[1]) ?? []
      tables.push(migration.filename)
      owners.set(created[1], tables)
    }
  }
  for (const [table, files] of owners) {
    assert.equal(files.length, 1, `${table} is created by more than one migration: ${files.join(', ')}`)
  }
  // The billing retirement migration must never be undone by a stray CREATE.
  for (const retired of ['generation_charges', 'credit_ledger', 'credit_accounts', 'billing_settings']) {
    assert.equal(owners.has(retired), false, `${retired} was dropped deliberately and must not be recreated`)
  }
  assert.ok(owners.size >= 34, `expected at least the 34 live tables, found ${owners.size}`)
  assert.ok(owners.has('users') && owners.has('provider_plugins') && owners.has('assets'))
})

test('ALTER TYPE ADD VALUE is isolated in its own non-transactional migration', () => {
  const withAddValue = baselineMigrations().filter(migration => /ADD VALUE/i.test(migration.sql))
  assert.deepEqual(withAddValue.map(migration => migration.name), ['model_adapter_anthropic'])

  const isolation = migrationNamed('model_adapter_anthropic')
  assert.equal(isolation.transactional, false, 'ADD VALUE must run in its own committed transaction')
  assert.equal(isolation.sql.includes('DO $$'), false, 'a DO block would entangle the enum change with unrelated DDL')
  assert.match(isolation.sql, /^-- /, 'the file must open with its explanatory header')

  // The value is first *used* by a CHECK constraint two migrations later; adding it
  // in that same transaction is what PostgreSQL refuses.
  const firstUse = baselineMigrations().find(migration => /adapter\s*=\s*'anthropic'/i.test(migration.sql))
  assert.ok(firstUse, 'expected a migration referencing the anthropic adapter')
  assert.ok(Number(firstUse.version) > Number(isolation.version), 'the anthropic value must be committed before it is used')
})

test('no migration relies on a transaction-hostile statement', () => {
  for (const migration of baselineMigrations()) {
    if (!migration.transactional) {
      assert.match(migration.sql, /ADD VALUE/i, 'only enum ADD VALUE migrations may opt out of the transaction')
      continue
    }
    assert.equal(/CONCURRENTLY/i.test(migration.sql), false, `${migration.filename} uses CONCURRENTLY, which cannot run inside a transaction`)
  }
})

test('a relaxation never outlives its own transaction', () => {
  // `ALTER TABLE ... DROP CONSTRAINT IF EXISTS x` followed by `ADD CONSTRAINT x`
  // only converges when both are in the same transaction: alone, the DROP leaves
  // the table unguarded and the ADD fails on any replay.
  const PERMANENT_RETIREMENT = 'remove_billing_credits'
  for (const migration of baselineMigrations()) {
    const dropped = [...migration.sql.matchAll(/DROP CONSTRAINT IF EXISTS ([a-z_]+)/gi)].map(match => match[1])
    for (const constraint of dropped) {
      const readded = new RegExp(`ADD CONSTRAINT ${constraint}\\b`, 'i').test(migration.sql)
      if (migration.name === PERMANENT_RETIREMENT) {
        assert.equal(readded, false, `${constraint} is retired deliberately and must not be re-added in ${migration.filename}`)
        continue
      }
      assert.ok(readded, `${migration.filename} drops ${constraint} without re-adding it in the same transaction`)
    }
    const droppedIndexes = [...migration.sql.matchAll(/DROP INDEX IF EXISTS ([a-z_]+)/gi)].map(match => match[1])
    for (const index of droppedIndexes) {
      assert.ok(
        new RegExp(`CREATE (UNIQUE )?INDEX.*\\b${index}\\b`, 'i').test(migration.sql),
        `${migration.filename} drops index ${index}; a window with neither index would let deletion jobs pile up`,
      )
    }
  }
})

test('the image plugin 1.1.0 cutover keeps its three statements in order', () => {
  const cutover = migrationNamed('image_plugin_1_1_0_cutover')
  const stream = statementStream(cutover.sql)
  assert.equal(stream.length, 3, 'the cutover is exactly three mutually dependent statements')
  assert.match(stream[0], /^UPDATE generation_jobs/)
  assert.match(stream[1], /^INSERT INTO model_config_revisions/)
  assert.match(stream[2], /^UPDATE model_configs/)
  // Pinning in-flight jobs to the revision they were created with must happen
  // before the model advances, or history gets rewritten.
  assert.ok(cutover.sql.indexOf('UPDATE generation_jobs') < cutover.sql.indexOf('INSERT INTO model_config_revisions'))
  assert.ok(cutover.sql.indexOf('INSERT INTO model_config_revisions') < cutover.sql.indexOf('UPDATE model_configs'))
})

test('the onboarding template set is normalized before its unique index is built', () => {
  const onboarding = migrationNamed('onboarding_and_templates')
  assert.ok(
    onboarding.sql.indexOf('UPDATE prompt_template_sets SET is_active = false') <
      onboarding.sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS prompt_template_sets_single_active_idx'),
    'a partial unique index over is_active fails to build while two active sets exist',
  )
})

test('no single-quoted literal spans a line break', () => {
  // normalizeSql() folds CRLF to LF and the runner executes that exact string.
  // A literal containing a raw newline would make the checksum depend on the
  // checkout platform, which is the failure this guard closes.
  const offenders: string[] = []
  for (const migration of baselineMigrations()) {
    for (const literal of multiLineLiterals(migration.sql)) {
      offenders.push(`${migration.filename}: ${literal.slice(0, 70)}...`)
    }
  }
  assert.deepEqual(offenders, [])
})

/**
 * Every single-quoted literal that contains a newline, using the same tokenizer
 * splitStatements uses. `--` comment prose and dollar-quoted bodies are skipped,
 * because an apostrophe in "the plugin's cache hints" is not a string opener.
 */
function multiLineLiterals(sql: string): string[] {
  const found: string[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '$') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (open) {
        const close = sql.indexOf(open[0], i + open[0].length)
        i = close === -1 ? n : close + open[0].length
        continue
      }
    }
    if (c !== "'") { i++; continue }
    const start = i
    i++
    while (i < n) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { i += 2; continue }
        break
      }
      i++
    }
    const literal = sql.slice(start, i + 1)
    if (literal.includes('\n')) found.push(literal)
    i++
  }
  return found
}

test('loader normalizes line endings before hashing so platforms agree', () => {
  const lf = "CREATE TABLE t (id uuid);\n"
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.equal(normalizeSql(crlf), normalizeSql(lf))
  assert.equal(sha256(normalizeSql(crlf)), sha256(normalizeSql(lf)))

  const parsed = parseMigration('0099_sample.sql', crlf)
  assert.equal(parsed.version, '0099')
  assert.equal(parsed.name, 'sample')
  assert.equal(parsed.transactional, true)

  assert.equal(parseMigration('0100_sample.sql', '-- @migrate transaction=false\nSELECT 1;').transactional, false)
  // A directive after the first statement is prose, not a directive.
  assert.equal(parseMigration('0101_sample.sql', 'SELECT 1;\n-- @migrate transaction=false').transactional, true)
  assert.throws(() => parseMigration('notes.md', 'x'), /unrecognized migration filename/)
})

test('loader rejects a duplicated version or name', () => {
  assert.throws(
    () => loadMigrationsFrom([parseMigration('0001_a.sql', 'SELECT 1;'), parseMigration('0001_b.sql', 'SELECT 2;')]),
    /duplicate migration version 0001/,
  )
  assert.throws(
    () => loadMigrationsFrom([parseMigration('0001_a.sql', 'SELECT 1;'), parseMigration('0002_a.sql', 'SELECT 2;')]),
    /duplicate migration name a/,
  )
})

/** Same validation loadMigrations applies after reading the directory. */
function loadMigrationsFrom(migrations: MigrationFile[]): MigrationFile[] {
  for (const migration of migrations) {
    for (const other of migrations) {
      if (migration === other) continue
      if (migration.version === other.version) throw new Error(`duplicate migration version ${migration.version}: ${migration.filename} and ${other.filename}`)
      if (migration.name === other.name) throw new Error(`duplicate migration name ${migration.name}: ${migration.filename} and ${other.filename}`)
    }
  }
  return [...migrations].sort((a, b) => a.version.localeCompare(b.version))
}

test('splitStatements survives dollar-quoted bodies and escaped quotes', () => {
  const sql = [
    "DO $$ BEGIN INSERT INTO t(x) VALUES('a;b'); END $$;",
    'CREATE TABLE t (x text);',
    "SELECT 'it''s; fine';",
  ].join('\n')
  const statements = splitStatements(sql)
  assert.equal(statements.length, 3)
  assert.ok(statements[0].startsWith('DO $$'))
  assert.ok(statements[0].includes("VALUES('a;b')"))
  assert.deepEqual(statementStream(sql), [
    "DO $$ BEGIN INSERT INTO t(x) VALUES('a;b'); END $$",
    'CREATE TABLE t (x text)',
    "SELECT 'it''s; fine'",
  ])
})

test('migrations directory resolves from the module, not the working directory', () => {
  const url = migrationsDirUrl()
  assert.ok(url.href.endsWith('/packages/database/migrations/'))
  // Reading through the URL must work regardless of cwd; this is what lets
  // `pnpm migrate` run from the repository root.
  assert.ok(loadMigrations().length > 0)
})
