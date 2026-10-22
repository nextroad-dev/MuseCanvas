// Worker-local runtime settings resolver (DB first, legacy env second, defaults last).
//
// This is the ONLY worker module that reads the migrated S3/runtime legacy env
// vars (S3_*, GENERATION_UPLOAD_*_SECONDS, MAX_UPLOAD_*, MAX_INPUT_IMAGES,
// PROVIDER_TIMEOUT_MS, MAX_OUTPUT_BYTES, JOB_LEASE_MS, PROMPT_TEMPLATE_INDEX_PATH).
// Every other worker module resolves configuration through this file so a
// settings change is observed without a restart. Imports stay side-effect free:
// nothing here connects to Redis/S3 at module load, so worker startup can run
// before onboarding exists and only storage operations require S3.
//
// Cache: single bounded process entry keyed by onboarding_state.config_revision
// and refreshed at most every 5 seconds. Decrypted secrets never leave worker
// internals: they are returned only to storage/credential call paths in this
// process and are never logged (see provider-state redactForLog).

import {
  db,
  getStorageSettingsRow,
  resolveStorageConfig,
  type ResolvedStorageConfig,
  type StorageSettingsRow,
} from '@musecanvas/database'
import {
  getActivePromptTemplateSet,
  listPromptTemplateEntries,
} from '@musecanvas/database/repositories/onboarding'
import { decryptForPurpose } from '@musecanvas/providers'
import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import { loadPromptTemplateIndex } from '@musecanvas/providers'

export type SettingsSource = 'database' | 'environment'

export type StorageConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

/**
 * Effective storage configuration from the shared resolver. Check `driver` and
 * `configured` before using the S3 fields. Secrets are worker-internal only: never
 * log them and never return them via API.
 */
export type ResolvedStorageSettings = ResolvedStorageConfig

/** Storage outcome kept apart from the other groups, so one bad storage config cannot fail runtime reads. */
type StorageLoad = { ok: true; value: ResolvedStorageSettings } | { ok: false; error: unknown }

export interface ResolvedRuntimeSettings {
  uploadTtlSeconds: number
  signedUrlTtlSeconds: number
  maxImageBytes: number
  maxTotalBytes: number
  maxInputs: number
  providerTimeoutMs: number
  maxOutputBytes: number
  jobLeaseMs: number
  revision: number
  source: SettingsSource
}

export interface ResolvedPromptTemplate {
  name: string
  description: string
  path: string
  instruction: string
  sha256: string
}

export interface ResolvedPromptTemplates {
  entries: ResolvedPromptTemplate[]
  source: SettingsSource
  setId: string | null
  version: number | null
}

interface CacheEntry {
  configRevision: number
  at: number
  storage: StorageLoad
  runtime: ResolvedRuntimeSettings
  templates: ResolvedPromptTemplates
}

const CACHE_TTL_MS = 5000

let cache: CacheEntry | null = null
let pending: Promise<CacheEntry> | null = null
let cacheEpoch = 0

export function invalidateRuntimeSettings(): void {
  cache = null
  pending = null
  cacheEpoch++
}

async function readConfigRevision(): Promise<number | null> {
  try {
    const res = await db().query('SELECT config_revision FROM onboarding_state WHERE singleton = true')
    const raw = res.rows[0]?.config_revision
    if (raw === undefined || raw === null) return null
    const revision = Number(raw)
    return Number.isSafeInteger(revision) ? revision : null
  } catch {
    return null
  }
}

function envText(name: string): string | null {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function envInt(name: string, minimum: number, maximum: number): number | null {
  const text = envText(name)
  if (text === null) return null
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null
  return parsed
}

function asSafeInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function loadStorageSettings(): Promise<StorageLoad> {
  let row: StorageSettingsRow | null = null
  try {
    row = await getStorageSettingsRow(db())
  } catch {
    // Missing table / DB down: the shared resolver then uses the environment block.
    row = null
  }
  try {
    // Driver, source, endpoint fallbacks and TTL bounds come from the shared resolver.
    // A decrypt failure on a usable row throws INVALID_CONFIG and never falls back to env.
    const value = resolveStorageConfig({
      row,
      decryptSecret: stored => decryptForPurpose(
        stored.secret_encrypted ?? '',
        'object-storage-credentials',
        stored.encryption_key_id ?? null,
      ),
      env: process.env,
    })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error }
  }
}

async function loadRuntimeSettings(): Promise<ResolvedRuntimeSettings> {
  try {
    const res = await db().query('SELECT * FROM runtime_settings WHERE singleton = true')
    const row = res.rows[0] as Record<string, unknown> | undefined
    if (row) {
      const pick = (key: string, fallback: number): number => {
        const parsed = asSafeInt(row[key])
        return parsed !== null ? parsed : fallback
      }
      return {
        uploadTtlSeconds: pick('upload_ttl_seconds', RUNTIME_SETTINGS_DEFAULTS.uploadTtlSeconds),
        signedUrlTtlSeconds: pick('signed_url_ttl_seconds', RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds),
        maxImageBytes: pick('max_image_bytes', RUNTIME_SETTINGS_DEFAULTS.maxImageBytes),
        maxTotalBytes: pick('max_total_bytes', RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes),
        maxInputs: pick('max_inputs', RUNTIME_SETTINGS_DEFAULTS.maxInputs),
        providerTimeoutMs: pick('provider_timeout_ms', RUNTIME_SETTINGS_DEFAULTS.providerTimeoutMs),
        maxOutputBytes: pick('max_output_bytes', RUNTIME_SETTINGS_DEFAULTS.maxOutputBytes),
        jobLeaseMs: pick('job_lease_ms', RUNTIME_SETTINGS_DEFAULTS.jobLeaseMs),
        revision: Number(row.revision ?? 0),
        source: 'database',
      }
    }
  } catch {
    // Missing table / DB down: fall through to env compatibility.
  }
  const runtime: ResolvedRuntimeSettings = {
    uploadTtlSeconds:
      envInt('GENERATION_UPLOAD_TTL_SECONDS', 300, 604800) ?? RUNTIME_SETTINGS_DEFAULTS.uploadTtlSeconds,
    signedUrlTtlSeconds:
      envInt('GENERATION_UPLOAD_SIGN_TTL_SECONDS', 60, 3600) ?? RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds,
    maxImageBytes:
      envInt('MAX_UPLOAD_IMAGE_BYTES', 1, 100_000_000) ?? RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
    maxTotalBytes:
      envInt('MAX_UPLOAD_TOTAL_BYTES', 1, 200_000_000) ?? RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes,
    maxInputs: envInt('MAX_INPUT_IMAGES', 1, 32) ?? RUNTIME_SETTINGS_DEFAULTS.maxInputs,
    providerTimeoutMs:
      envInt('PROVIDER_TIMEOUT_MS', 1000, 600_000) ?? RUNTIME_SETTINGS_DEFAULTS.providerTimeoutMs,
    maxOutputBytes:
      envInt('MAX_OUTPUT_BYTES', 1, 100_000_000) ?? RUNTIME_SETTINGS_DEFAULTS.maxOutputBytes,
    jobLeaseMs: envInt('JOB_LEASE_MS', 1000, 3_600_000) ?? RUNTIME_SETTINGS_DEFAULTS.jobLeaseMs,
    revision: 0,
    source: 'environment',
  }
  return runtime
}

async function loadPromptTemplates(): Promise<ResolvedPromptTemplates> {
  try {
    const set = await getActivePromptTemplateSet(db())
    if (set) {
      const entries = await listPromptTemplateEntries(db(), set.id)
      const resolved = entries
        .filter(entry => entry.instruction && entry.contentSha256)
        .map(entry => ({
          name: entry.name,
          description: entry.description,
          path: entry.path,
          instruction: entry.instruction as string,
          sha256: entry.contentSha256 as string,
        }))
      if (resolved.length > 0) {
        return { entries: resolved, source: 'database', setId: set.id, version: set.version }
      }
    }
  } catch {
    // Missing tables / DB down: fall through to file compatibility.
  }
  try {
    const index = await loadPromptTemplateIndex()
    const entries = (index.valid ? index.entries : [])
      .filter(entry => entry.valid && entry.instruction && entry.sha256)
      .map(entry => ({
        name: entry.name,
        description: entry.description,
        path: entry.path,
        instruction: entry.instruction as string,
        sha256: entry.sha256 as string,
      }))
    return { entries, source: 'environment', setId: null, version: null }
  } catch {
    return { entries: [], source: 'environment', setId: null, version: null }
  }
}

async function ensureCache(): Promise<CacheEntry> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache
  if (pending) return pending
  const epoch = cacheEpoch
  const refresh = async (): Promise<CacheEntry> => {
    const revision = await readConfigRevision()
    const [storage, runtime, templates] = await Promise.all([
      loadStorageSettings(), loadRuntimeSettings(), loadPromptTemplates(),
    ])
    const next = { configRevision: revision ?? -1, at: Date.now(), storage, runtime, templates }
    // A local invalidate must not be undone by a refresh that started earlier.
    if (epoch !== cacheEpoch) return ensureCache()
    cache = next
    return next
  }
  const work = refresh()
  pending = work
  try { return await work }
  finally { if (pending === work) pending = null }
}

export async function resolveStorageSettings(): Promise<ResolvedStorageSettings> {
  const storage = (await ensureCache()).storage
  if (!storage.ok) throw storage.error
  return storage.value
}

export async function resolveRuntimeSettings(): Promise<ResolvedRuntimeSettings> {
  return (await ensureCache()).runtime
}

export async function resolvePromptTemplates(): Promise<ResolvedPromptTemplates> {
  return (await ensureCache()).templates
}

/** Signed-URL / soft-delete grace TTL shared by maintenance sweeps. */
export async function resolveUploadSignTtlSeconds(): Promise<number> {
  return (await resolveRuntimeSettings()).signedUrlTtlSeconds
}

/** Provider request timeout applied to media submit/poll/read paths. */
export async function resolveProviderTimeoutMs(): Promise<number> {
  return (await resolveRuntimeSettings()).providerTimeoutMs
}

/** Bounded output byte cap applied to provider output reads. */
export async function resolveMaxOutputBytes(): Promise<number> {
  return (await resolveRuntimeSettings()).maxOutputBytes
}

/** Redis permit lease window for queue capacity acquisition. */
export async function resolveJobLeaseMs(): Promise<number> {
  return (await resolveRuntimeSettings()).jobLeaseMs
}
