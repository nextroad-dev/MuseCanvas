import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../../../../packages/database/src/index'
import {
  formatPluginKey,
  globalPluginRegistry,
  PLUGIN_ARTIFACT_MAX_BYTES,
  scanPluginSource,
  validatePluginManifest,
} from '../../../../packages/providers/src/index'
import type {
  AnyProviderManifest,
  LanguageProviderPlugin,
  MediaProviderPlugin,
} from '../../../../packages/providers/src/index'
import { getStorageClient } from '../shared/storage'
import { redactForLog } from '../provider-state'
import {
  forgetPluginStatus,
  installedActiveCount,
  isBuiltinMediaKey,
  setPluginStatus,
  statusOf,
  trackedPluginKeys,
} from './availability'

/*
 * The worker is the only process that ever executes uploaded plugin code, so
 * each step below is a refusal point rather than a convenience: size cap before
 * the fetch, sha256 before the artifact touches disk or import(), manifest
 * shape and identity before registration.
 */

export const PLUGIN_IMPORT_TIMEOUT_MS = 5_000
/** Upper bound on installed packages kept live in one worker process. */
export const MAX_INSTALLED_PLUGINS = 40
/** Rows pulled per refresh; the watermark only advances as far as the rows read. */
export const PLUGIN_REFRESH_LIMIT = 100
/** Wall-clock budget index.ts grants the pre-boot catalog pass before moving on. */
export const PLUGIN_BOOT_REFRESH_BUDGET_MS = 10_000
/** Ticks between two full catalog sweeps (5 s tick => ~60 s). */
export const PLUGIN_FULL_SWEEP_EVERY_TICKS = 12

export const DEFAULT_PLUGIN_CACHE_DIR = '/tmp/musecanvas-plugin-cache'

export type PluginCatalogStatus = 'pending' | 'active' | 'disabled' | 'failed'
export type PluginKind = 'media' | 'language'

export interface PluginRow {
  id: string
  pluginId: string
  pluginVersion: string
  kind: PluginKind
  status: PluginCatalogStatus
  objectKey: string
  artifactSha256: string
  artifactSizeBytes: number
  manifest: unknown
  updatedAtMs: number
}

export interface PluginLoadOutcome {
  status: PluginCatalogStatus
  cacheHit: boolean
  code?: string
}

export interface PluginRefreshResult {
  mode: 'full' | 'incremental'
  rows: number
  loaded: number
  failed: number
  /** Keys whose mirrored availability moved during this pass. */
  changed: number
  watermarkMs: number | null
}

/**
 * A load rejection. `permanent: false` marks a transport problem (storage not
 * configured yet, object read failed): the row stays `pending` and is retried,
 * because `failed` is terminal for the admin and a storage blip must never
 * force a re-upload.
 */
export class PluginLoadRejection extends Error {
  readonly code: string
  readonly permanent: boolean
  constructor(code: string, detail: string, permanent = true) {
    super(detail)
    this.name = code
    this.code = code
    this.permanent = permanent
  }
}

export interface PluginLoaderDeps {
  /** Artifact bytes for one object key. Defaults to the worker's own S3 handle. */
  getObject?: (key: string) => Promise<Uint8Array>
  /** Catalog status write. Defaults to `provider_plugins` through db(). */
  promote?: (
    row: PluginRow,
    status: 'active' | 'failed',
    failure?: { code: string; message: string },
  ) => Promise<boolean>
  /** Catalog read. Defaults to `provider_plugins` through db(). */
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  cacheDir?: string
  importModule?: (specifier: string) => Promise<unknown>
  /** Bounds the wait for import(); tests shorten it. */
  importTimeoutMs?: number
  /** Forces a full sweep (boot, tests) instead of the watermark path. */
  full?: boolean
}

export function pluginCacheDir(override?: string): string {
  const configured = (override || process.env.PLUGIN_CACHE_DIR || DEFAULT_PLUGIN_CACHE_DIR).trim()
  const abs = resolve(configured)
  // /app is the image's application layer: replaced on every deploy and often
  // read-only, so a cache write there is both pointless and fatal.
  const comparable = abs.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  if (comparable === '/app' || comparable.startsWith('/app/')) {
    console.warn('plugin cache dir moved out of the image layer', { code: 'PLUGIN_CACHE_DIR_INVALID' })
    return resolve(join(tmpdir(), 'musecanvas-plugin-cache'))
  }
  return abs
}

/** Content-addressed on the verified digest, so one artifact is materialized once. */
export function pluginCachePath(digest: string, cacheDir?: string): string {
  return join(pluginCacheDir(cacheDir), `${digest}.mjs`)
}

async function readArtifactFromStorage(key: string): Promise<Uint8Array> {
  const { s3, bucket } = await getStorageClient()
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!res.Body) throw new PluginLoadRejection('PLUGIN_ARTIFACT_UNAVAILABLE', 'object has no body', false)
  // Bound before buffering: a tampered or duplicated key must not allocate freely.
  if (res.ContentLength !== undefined && res.ContentLength > PLUGIN_ARTIFACT_MAX_BYTES) {
    throw new PluginLoadRejection('PLUGIN_ARTIFACT_TOO_LARGE', `artifact exceeds ${PLUGIN_ARTIFACT_MAX_BYTES} bytes`)
  }
  const bytes = await res.Body.transformToByteArray()
  if (bytes.length > PLUGIN_ARTIFACT_MAX_BYTES) {
    throw new PluginLoadRejection('PLUGIN_ARTIFACT_TOO_LARGE', `artifact exceeds ${PLUGIN_ARTIFACT_MAX_BYTES} bytes`)
  }
  return bytes
}

function redactMessage(value: string): string {
  return String(redactForLog(value)).slice(0, 500)
}

/**
 * The worker is the only writer that promotes a `pending` row, and the write is
 * CAS-guarded on the status that was read: a row an admin already moved is never
 * overwritten, and a `failed` row is never resurrected.
 */
async function promotePluginRow(
  row: PluginRow,
  status: 'active' | 'failed',
  failure?: { code: string; message: string },
): Promise<boolean> {
  const res = await db().query(
    `UPDATE provider_plugins
     SET status=$2, error_code=$3, error_message=$4, updated_at=now()
     WHERE id=$1 AND status=$5 AND deleted_at IS NULL`,
    [row.id, status, failure?.code ?? null, failure ? redactMessage(failure.message) : null, row.status],
  )
  return Boolean(res.rowCount && res.rowCount > 0)
}

const CATALOG_COLUMNS = `p.id, p.plugin_id, p.plugin_version, p.kind, p.status, p.object_key,
       p.artifact_sha256, p.artifact_size_bytes, p.manifest,
       (EXTRACT(EPOCH FROM p.updated_at) * 1000)::float8 AS updated_at_ms,
       (EXTRACT(EPOCH FROM tick.ts) * 1000)::float8 AS watermark_ms`

const INCREMENTAL_CATALOG_SQL = `WITH tick AS (SELECT now() AS ts)
SELECT ${CATALOG_COLUMNS}
FROM provider_plugins p, tick
WHERE p.deleted_at IS NULL AND p.updated_at > $1 AND p.updated_at <= tick.ts
ORDER BY p.updated_at ASC
LIMIT $2`

const FULL_CATALOG_SQL = `WITH tick AS (SELECT now() AS ts)
SELECT ${CATALOG_COLUMNS}
FROM provider_plugins p, tick
WHERE p.deleted_at IS NULL
ORDER BY p.updated_at ASC
LIMIT $1`

const CATALOG_STATUSES: PluginCatalogStatus[] = ['pending', 'active', 'disabled', 'failed']

function mapCatalogRow(row: Record<string, unknown>): PluginRow | null {
  const id = typeof row.id === 'string' ? row.id : ''
  const pluginId = typeof row.plugin_id === 'string' ? row.plugin_id : ''
  const pluginVersion = typeof row.plugin_version === 'string' ? row.plugin_version : ''
  const objectKey = typeof row.object_key === 'string' ? row.object_key : ''
  // Lowercased so a stored digest written any other way still compares.
  const sha256 = (typeof row.artifact_sha256 === 'string' ? row.artifact_sha256 : '').toLowerCase()
  const kind = row.kind === 'media' || row.kind === 'language' ? row.kind : null
  const status = CATALOG_STATUSES.includes(row.status as PluginCatalogStatus)
    ? (row.status as PluginCatalogStatus)
    : null
  if (!id || !pluginId || !pluginVersion || !objectKey || !kind || !status || !/^[0-9a-f]{64}$/.test(sha256)) {
    // Unusable metadata: leave the key untracked, which the gate reads as unavailable.
    console.error('plugin catalog row skipped', { pluginId: pluginId || 'unknown', code: 'PLUGIN_ROW_METADATA_INVALID' })
    return null
  }
  return {
    id,
    pluginId,
    pluginVersion,
    kind,
    status,
    objectKey,
    artifactSha256: sha256,
    artifactSizeBytes: Number(row.artifact_size_bytes) || 0,
    manifest: row.manifest,
    updatedAtMs: Number(row.updated_at_ms) || 0,
  }
}

/** Required callable surface per kernel, on top of a manifest that already validates. */
function missingInterfaceMember(plugin: Record<string, unknown>, manifest: AnyProviderManifest): string | null {
  if (typeof plugin.validateConfig !== 'function') return 'validateConfig'
  if (manifest.kind === 'media') {
    if (typeof plugin.validateRequest !== 'function') return 'validateRequest'
    if (typeof plugin.submit !== 'function') return 'submit'
    for (const optional of ['poll', 'cancel', 'openOutput', 'probe'] as const) {
      if (plugin[optional] !== undefined && typeof plugin[optional] !== 'function') return optional
    }
    return null
  }
  if (typeof plugin.complete !== 'function') return 'complete'
  if (plugin.probe !== undefined && typeof plugin.probe !== 'function') return 'probe'
  return null
}

function validatePluginShape(module: unknown):
  { ok: true; plugin: Record<string, unknown>; manifest: AnyProviderManifest } | { ok: false; code: string; detail: string } {
  const exported = (module as { default?: unknown } | null)?.default
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
    return { ok: false, code: 'PLUGIN_NO_DEFAULT_EXPORT', detail: 'the bundle must carry the plugin object as `export default`' }
  }
  const plugin = exported as Record<string, unknown>
  if (!plugin.manifest || typeof plugin.manifest !== 'object' || Array.isArray(plugin.manifest)) {
    return { ok: false, code: 'PLUGIN_MANIFEST_INVALID', detail: 'manifest must be an object' }
  }
  const checked = validatePluginManifest(plugin.manifest)
  if (!checked.ok) {
    return { ok: false, code: 'PLUGIN_MANIFEST_INVALID', detail: checked.findings.map(finding => finding.rule).join(',') }
  }
  const missing = missingInterfaceMember(plugin, checked.manifest)
  if (missing) return { ok: false, code: 'PLUGIN_INTERFACE_INVALID', detail: `required function '${missing}' is missing` }
  return { ok: true, plugin, manifest: checked.manifest }
}

function identityFailure(row: PluginRow, manifest: AnyProviderManifest): string | null {
  if (manifest.kind !== row.kind) return 'PLUGIN_KIND_MISMATCH'
  if (manifest.id !== row.pluginId) return 'PLUGIN_ID_MISMATCH'
  if (manifest.version !== row.pluginVersion) return 'PLUGIN_VERSION_MISMATCH'
  return null
}

async function materialize(absPath: string, bytes: Uint8Array, digest: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  try {
    // Trust but verify: the path is content-addressed, but a bit-rotted or
    // tampered file already sitting under that name must never be imported on
    // the strength of its size alone.
    const existing = await readFile(absPath)
    if (existing.length === bytes.length && createHash('sha256').update(existing).digest('hex') === digest) return
  } catch {
    // not materialized in this container yet
  }
  await writeFile(`${absPath}.part`, bytes)
  // rename(2) is atomic within one filesystem, so import() can never observe a
  // half-written bundle even when two workers share the cache dir.
  await rename(`${absPath}.part`, absPath)
}

async function importBundle(absPath: string, deps: PluginLoaderDeps): Promise<unknown> {
  const importModule = deps.importModule ?? ((specifier: string) => import(specifier))
  const timeoutMs = deps.importTimeoutMs ?? PLUGIN_IMPORT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The race bounds only our wait: a module that spins at import time keeps
    // running on this event loop and cannot be cancelled from here. Containment
    // is the zero-runtime-import scan (plus the top-level-await rule) above.
    return await Promise.race([
      importModule(pathToFileURL(absPath).href),
      new Promise<never>((_settle, reject) => {
        timer = setTimeout(
          () => reject(new PluginLoadRejection('PLUGIN_IMPORT_TIMEOUT', `import() did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Load one catalog row: fetch the artifact, verify its digest, materialize it in
 * the cache dir, import it, validate its shape and identity, then register it.
 * Returns the catalog status the row ended up in.
 */
export async function loadPluginRow(row: PluginRow, deps: PluginLoaderDeps = {}): Promise<PluginLoadOutcome> {
  const key = formatPluginKey(row.pluginId, row.pluginVersion)
  const logLine = (code: string): Record<string, unknown> =>
    redactForLog({ pluginId: row.pluginId, version: row.pluginVersion, kind: row.kind, code }) as Record<string, unknown>
  const reject = async (code: string, detail: string): Promise<PluginLoadOutcome> => {
    setPluginStatus(row.pluginId, row.pluginVersion, 'failed')
    const promoted = await (deps.promote ?? promotePluginRow)(row, 'failed', { code, message: detail })
    // CAS miss means someone else moved the row: stop guessing until the next read.
    if (!promoted) forgetPluginStatus(row.pluginId, row.pluginVersion)
    console.error('plugin load rejected', logLine(code))
    return { status: 'failed', cacheHit: false, code }
  }
  const defer = (code: string): PluginLoadOutcome => {
    forgetPluginStatus(row.pluginId, row.pluginVersion)
    // Warn, not error: this repeats on every tick until storage recovers.
    console.warn('plugin load deferred', logLine(code))
    return { status: 'pending', cacheHit: false, code }
  }

  // A bundle may never shadow a built-in: registration is append-only, so the key
  // would keep resolving to the image's code while the artifact silently went unused.
  if (isBuiltinMediaKey(row.pluginId, row.pluginVersion)) {
    return reject('PLUGIN_RESERVED_KEY', `${key} is reserved for a built-in plugin`)
  }
  if (row.status === 'disabled' || row.status === 'failed') {
    setPluginStatus(row.pluginId, row.pluginVersion, row.status)
    return { status: row.status, cacheHit: false }
  }
  // Already in this process (same id@version, hence same digest): no S3 read, no second import().
  if (globalPluginRegistry.has(row.pluginId, row.pluginVersion)) {
    setPluginStatus(row.pluginId, row.pluginVersion, 'active')
    return { status: 'active', cacheHit: true }
  }
  if (installedActiveCount() >= MAX_INSTALLED_PLUGINS) {
    return reject('PLUGIN_CAPACITY_EXCEEDED', `only ${MAX_INSTALLED_PLUGINS} installed plugins load per worker`)
  }
  if (row.artifactSizeBytes > PLUGIN_ARTIFACT_MAX_BYTES) {
    return reject('PLUGIN_ARTIFACT_TOO_LARGE', `artifact_size_bytes ${row.artifactSizeBytes} exceeds ${PLUGIN_ARTIFACT_MAX_BYTES}`)
  }

  let bytes: Uint8Array
  try {
    bytes = await (deps.getObject ?? readArtifactFromStorage)(row.objectKey)
  } catch (error) {
    if (error instanceof PluginLoadRejection && error.permanent) return reject(error.code, error.message)
    return defer('PLUGIN_ARTIFACT_FETCH_PENDING')
  }
  if (bytes.length > PLUGIN_ARTIFACT_MAX_BYTES) {
    return reject('PLUGIN_ARTIFACT_TOO_LARGE', `artifact exceeds ${PLUGIN_ARTIFACT_MAX_BYTES} bytes`)
  }

  // Integrity boundary: the digest is recomputed over the fetched bytes, so a
  // corrupted or swapped artifact never reaches import() — and never even lands
  // in the cache directory it would be imported from.
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== row.artifactSha256) {
    return reject('PLUGIN_ARTIFACT_HASH_MISMATCH', `expected ${row.artifactSha256}, artifact hashes as ${digest}`)
  }

  const scanErrors = scanPluginSource(Buffer.from(bytes).toString('utf8')).filter(finding => finding.severity === 'error')
  if (scanErrors.length) {
    return reject('PLUGIN_ARTIFACT_SCAN_FAILED', scanErrors.map(finding => finding.rule).join(','))
  }

  const absPath = pluginCachePath(digest, deps.cacheDir)
  try {
    await materialize(absPath, bytes, digest)
  } catch {
    return defer('PLUGIN_CACHE_WRITE_FAILED')
  }

  let module: unknown
  try {
    module = await importBundle(absPath, deps)
  } catch (error) {
    const code = error instanceof PluginLoadRejection ? error.code : 'PLUGIN_IMPORT_FAILED'
    return reject(code, error instanceof Error ? error.message : 'import() failed')
  }

  const shape = validatePluginShape(module)
  if (!shape.ok) return reject(shape.code, shape.detail)
  const mismatch = identityFailure(row, shape.manifest)
  if (mismatch) {
    return reject(mismatch, `bundle declares ${shape.manifest.kind} ${shape.manifest.id}@${shape.manifest.version}`)
  }

  try {
    // Guarded by has(): the registries are append-only and throw on a duplicate key.
    if (!globalPluginRegistry.has(shape.manifest.id, shape.manifest.version)) {
      if (shape.manifest.kind === 'media') {
        globalPluginRegistry.registerMedia(shape.plugin as unknown as MediaProviderPlugin)
      } else {
        globalPluginRegistry.registerLanguage(shape.plugin as unknown as LanguageProviderPlugin)
      }
    }
  } catch {
    return reject('PLUGIN_REGISTRATION_FAILED', 'the plugin object was rejected by its kernel registry')
  }

  // Only a `pending` row is ever promoted; reloading a row the catalog already
  // calls `active` (a worker restart pulling from the warm cache) writes nothing.
  const promoted = row.status === 'pending' ? await (deps.promote ?? promotePluginRow)(row, 'active') : true
  if (!promoted) {
    forgetPluginStatus(row.pluginId, row.pluginVersion)
    console.error('plugin promotion superseded', logLine('PLUGIN_PROMOTION_SUPERSEDED'))
    return { status: 'pending', cacheHit: false, code: 'PLUGIN_PROMOTION_SUPERSEDED' }
  }
  setPluginStatus(row.pluginId, row.pluginVersion, 'active')
  console.log('plugin loaded', logLine('PLUGIN_LOADED'))
  return { status: 'active', cacheHit: false }
}

let watermarkMs: number | null = null
let tickCount = 0
let inFlight: Promise<PluginRefreshResult> | null = null

async function runRefresh(deps: PluginLoaderDeps, full: boolean): Promise<PluginRefreshResult> {
  const query = deps.query ?? ((sql: string, params?: unknown[]) => db().query(sql, params))
  const params = full ? [PLUGIN_REFRESH_LIMIT] : [new Date(watermarkMs ?? 0), PLUGIN_REFRESH_LIMIT]
  const res = await query(full ? FULL_CATALOG_SQL : INCREMENTAL_CATALOG_SQL, params)
  const rows: PluginRow[] = []
  let tickMs = Number.NaN
  for (const raw of res.rows) {
    if (Number.isFinite(Number(raw.watermark_ms))) tickMs = Number(raw.watermark_ms)
    const mapped = mapCatalogRow(raw)
    if (mapped) rows.push(mapped)
  }
  const result: PluginRefreshResult = {
    mode: full ? 'full' : 'incremental',
    rows: rows.length,
    loaded: 0,
    failed: 0,
    changed: 0,
    watermarkMs,
  }
  const seen = new Set<string>()
  for (const row of rows) {
    seen.add(formatPluginKey(row.pluginId, row.pluginVersion))
    const target = row.status === 'pending' ? 'untracked' : row.status
    if (statusOf(row.pluginId, row.pluginVersion) !== target) {
      result.changed += 1
      if (target === 'untracked') forgetPluginStatus(row.pluginId, row.pluginVersion)
      else setPluginStatus(row.pluginId, row.pluginVersion, target)
    }
    // A row the admin already marked `active` still needs importing after a worker
    // restart: the registries start empty each process, so reload from the cache.
    const reserved = isBuiltinMediaKey(row.pluginId, row.pluginVersion)
    const needsLoad = (row.status === 'pending' || row.status === 'active')
      && (reserved || !globalPluginRegistry.has(row.pluginId, row.pluginVersion))
    if (!needsLoad) continue
    const outcome = await loadPluginRow(row, deps)
    if (outcome.status === 'active') result.loaded += 1
    if (outcome.status === 'failed') result.failed += 1
  }
  if (rows.length) {
    // Advance only as far as the rows actually read: a capped pass leaves the
    // newer tail for the next tick instead of skipping it.
    const maxSeen = rows.reduce((max, row) => Math.max(max, row.updatedAtMs), 0)
    const next = rows.length >= PLUGIN_REFRESH_LIMIT ? maxSeen : (Number.isFinite(tickMs) ? tickMs : maxSeen)
    if (Number.isFinite(next) && next > (watermarkMs ?? -1)) {
      watermarkMs = next
      result.watermarkMs = next
    }
  }
  if (full && rows.length < PLUGIN_REFRESH_LIMIT) {
    // Soft-deleted or hard-deleted rows never appear in a result set; a periodic
    // full sweep is what stops the gate from trusting a stale `active` forever.
    for (const tracked of trackedPluginKeys()) {
      if (isBuiltinMediaKey(tracked.pluginId, tracked.pluginVersion)) continue
      if (seen.has(formatPluginKey(tracked.pluginId, tracked.pluginVersion))) continue
      forgetPluginStatus(tracked.pluginId, tracked.pluginVersion)
      result.changed += 1
    }
  }
  return result
}

/**
 * Mirrors `provider_plugins` into the availability gate and loads what is missing.
 *
 * Every failure is contained: storage is deliberately optional at boot
 * (assertBootstrapConfig requires only DB/Redis/master key), so a worker with no
 * S3 configuration must still come up and serve the built-in plugins.
 *
 * `ALLOW_PLUGIN_UPLOAD` gates the upload endpoint in apps/api and is not re-checked
 * here: flipping it off must not strand a package the admin already installed —
 * that is what `status='disabled'` is for.
 */
export async function refreshPlugins(deps: PluginLoaderDeps = {}): Promise<PluginRefreshResult> {
  if (inFlight) return inFlight
  tickCount += 1
  const full = deps.full === true || watermarkMs === null || tickCount % PLUGIN_FULL_SWEEP_EVERY_TICKS === 0
  const run = runRefresh(deps, full).catch((error: unknown): PluginRefreshResult => {
    console.error('plugin catalog refresh failed', redactForLog({
      code: error instanceof Error ? error.name : 'PLUGIN_REFRESH_FAILED',
    }) as Record<string, unknown>)
    return { mode: full ? 'full' : 'incremental', rows: 0, loaded: 0, failed: 0, changed: 0, watermarkMs }
  }).finally(() => { inFlight = null })
  inFlight = run
  return run
}

/** Test hook: rewinds the watermark and tick counter without touching the registries. */
export function resetPluginLoaderState(): void {
  watermarkMs = null
  tickCount = 0
  inFlight = null
}
