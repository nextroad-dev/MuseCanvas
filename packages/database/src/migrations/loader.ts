import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * Migration discovery and parsing. Pure: no `pg`, no pool, no side effects on
 * import, so it is unit-testable without a database and safe to use from both
 * the CLI entry script and the test suite.
 */

/** Highest migration produced by the split of the historical migrate.ts blob. */
export const BASELINE_MAX_VERSION = '0026'

const MIGRATION_FILENAME = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/

export type MigrationFile = {
  /** Zero-padded ordering token, e.g. '0001'. */
  version: string
  /** Filename stem without version or extension, e.g. 'extensions_and_enums'. */
  name: string
  filename: string
  /** Newline-normalized, trimmed SQL. This exact string is both hashed and executed. */
  sql: string
  checksum: string
  /** False only via an explicit `-- @migrate transaction=false` directive. */
  transactional: boolean
}

/**
 * Postgres reports a different checksum for the same SQL on a CRLF checkout
 * than on an LF one, and this repository has `core.autocrlf=true` with no
 * `.gitattributes`. Normalizing before hashing (and before executing, so the
 * two can never disagree) is what keeps a Windows developer and the Linux
 * container in agreement.
 */
export function normalizeSql(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim()
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function parseMigration(filename: string, raw: string): MigrationFile {
  const match = MIGRATION_FILENAME.exec(filename)
  if (!match) throw new Error(`unrecognized migration filename: ${filename}`)
  const [, version, name] = match
  const sql = normalizeSql(raw)
  let transactional = true
  for (const line of sql.split('\n')) {
    const trimmed = line.trim()
    // Directives are comments, so the file stays valid SQL for any external tool.
    if (trimmed.startsWith('-- @migrate ')) {
      const [, key, value] = /-- @migrate\s+([a-z_]+)\s*=\s*(\S+)/.exec(trimmed) ?? []
      if (key === 'transaction') transactional = value !== 'false'
      continue
    }
    if (trimmed.startsWith('--') || trimmed === '') continue
    break
  }
  return { version, name, filename, sql, checksum: sha256(sql), transactional }
}

/** `packages/database/migrations/`, resolved from this module rather than cwd. */
export function migrationsDirUrl(): URL {
  return new URL('../../migrations/', import.meta.url)
}

function readFilenames(dir: string | URL): string[] {
  return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function migrationPath(dir: string | URL, filename: string): string | URL {
  // Accepting a plain path matters for the runner's `dir` option and for tests
  // that point at a fixture directory; a URL would throw on `new URL(x, string)`.
  if (typeof dir === 'string') return dir.endsWith('/') ? `${dir}${filename}` : `${dir}/${filename}`
  return new URL(filename, dir)
}

export function listUnknownMigrationFiles(dir: string | URL = migrationsDirUrl()): string[] {
  return readFilenames(dir).filter(entry => {
    if (entry === '.gitkeep' || entry.startsWith('.')) return false
    return !MIGRATION_FILENAME.test(entry)
  })
}

/** Migrations in execution order. Throws on a duplicate version or name. */
export function loadMigrations(dir: string | URL = migrationsDirUrl()): MigrationFile[] {
  const migrations: MigrationFile[] = []
  for (const entry of readFilenames(dir)) {
    if (!MIGRATION_FILENAME.test(entry)) continue
    migrations.push(parseMigration(entry, readFileSync(migrationPath(dir, entry), 'utf8')))
  }
  const byVersion = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const migration of migrations) {
    if (byVersion.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}: ${byVersion.get(migration.version)} and ${migration.filename}`)
    }
    if (byName.has(migration.name)) {
      throw new Error(`duplicate migration name ${migration.name}: ${byName.get(migration.name)} and ${migration.filename}`)
    }
    byVersion.set(migration.version, migration.filename)
    byName.set(migration.name, migration.filename)
  }
  // Zero-padded versions sort lexicographically; no semver involved.
  return migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}

/**
 * Split SQL into top-level statements, terminating only on a `;` at depth zero:
 * outside single-quoted literals (with `''` escapes), outside dollar-quoted
 * blocks (`$$` / `$tag$`), and ignoring `;` inside line comments.
 *
 * The migration runner deliberately never calls this — it sends each file as one
 * simple query so Postgres wraps it in a single implicit transaction. This exists
 * for the guard tests, which need to compare statement streams. A naive `;`
 * split would sever every `DO $$ ... $$;` body in the schema.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = []
  const source = normalizeSql(text)
  const n = source.length
  let i = 0
  let start = 0
  while (i < n) {
    const c = source[i]
    if (c === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === "'") {
      i++
      while (i < n) {
        if (source[i] === "'") {
          if (source[i + 1] === "'") { i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '$') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i))
      if (open) {
        const close = source.indexOf(open[0], i + open[0].length)
        if (close === -1) throw new Error(`unterminated dollar quote ${open[0]} at offset ${i} of migration SQL`)
        i = close + open[0].length
        continue
      }
    }
    if (c === ';') {
      out.push(source.slice(start, i + 1))
      i++
      start = i
      continue
    }
    i++
  }
  if (source.slice(start).trim()) out.push(source.slice(start))
  return out
}

/**
 * Statement text with `--` comment lines and layout whitespace removed, so two
 * files can be compared for content equality regardless of how they are wrapped.
 * The terminating `;` is dropped too: it is a separator, not part of the
 * statement, and the historical `ALTER TYPE ... 'anthropic'` round-trip was
 * executed without one.
 */
export function normalizeStatement(statement: string): string {
  return statement
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
}

/** The comparable content of a SQL text: its normalized statement stream. */
export function statementStream(text: string): string[] {
  return splitStatements(text).map(normalizeStatement).filter(Boolean)
}
