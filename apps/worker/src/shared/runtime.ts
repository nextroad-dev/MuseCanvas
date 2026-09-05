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

import { db } from '../../../../packages/database/src/index'
import {
  getActivePromptTemplateSet,
  listPromptTemplateEntries,
} from '../../../../packages/database/src/repositories/onboarding'
import { decryptForPurpose } from '../../../../packages/providers/src/index'
import { RUNTIME_SETTINGS_DEFAULTS } from '../../../../packages/contracts/src/index'
import { loadPromptTemplateIndex } from '../../../../packages/providers/src/index'

export type SettingsSource = 'database' | 'environment'

export type StorageConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

export interface ResolvedStorageSettings {
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  /** Decrypted plaintext. Worker-internal only: never log, never return via API. */
  secretAccessKey: string | null
  signedUrlTtlSeconds: number
  status: StorageConnectionStatus
  revision: number
  source: SettingsSource
}

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
  storage: ResolvedStorageSettings
  runtime: ResolvedRuntimeSettings
  templates: ResolvedPromptTemplates
}

const CACHE_TTL_MS = 5000

let cache: CacheEntry | null = null

export function invalidateRuntimeSettings(): void {
  cache = null
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

async function loadStorageSettings(): Promise<ResolvedStorageSettings> {
  try {
    const res = await db().query('SELECT * FROM object_storage_settings WHERE singleton = true')
    const row = res.rows[0] as Record<string, unknown> | undefined
    if (row) {
      const status = String(row.status || 'not_configured') as StorageConnectionStatus
      if (status === 'configured' || status === 'verified') {
        const endpoint = (row.endpoint as string | null) || null
        const publicEndpoint = (row.public_endpoint as string | null) || null
        const region = (row.region as string | null) || 'us-east-1'
        const bucket = (row.bucket as string | null) || null
        const accessKeyId = (row.access_key_id as string | null) || null
        const ttl = asSafeInt(row.signed_url_ttl_seconds)
        const signedUrlTtlSeconds =
          ttl !== null && ttl >= 60 && ttl <= 3600 ? ttl : RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds
        const ciphertext = (row.secret_encrypted as string | null) || null
        const keyId = (row.encryption_key_id as string | null) || null
        let secretAccessKey: string | null = null
        if (ciphertext) {
          try {
            secretAccessKey = decryptForPurpose(ciphertext, 'object-storage-credentials', keyId)
          } catch {
            throw new Error('INVALID_CONFIG')
          }
        }
        return {
          endpoint,
          publicEndpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey,
          signedUrlTtlSeconds,
          status,
          revision: Number(row.revision ?? 0),
          source: 'database',
        }
      }
    }
  } catch (error) {
    // INVALID_CONFIG from a failed decrypt must fail closed, never fall back.
    if (error instanceof Error && error.message === 'INVALID_CONFIG') throw error
    // Missing table / missing row / DB down: fall through to env compatibility.
  }
  const endpoint = envText('S3_ENDPOINT') || envText('S3_PUBLIC_ENDPOINT')
  const publicEndpoint = envText('S3_PUBLIC_ENDPOINT') || endpoint
  const region = envText('S3_REGION') || 'us-east-1'
  const bucket = envText('S3_BUCKET')
  const accessKeyId = envText('S3_ACCESS_KEY_ID')
  const secretAccessKey = envText('S3_SECRET_ACCESS_KEY')
  const signedUrlTtlSeconds =
    envInt('GENERATION_UPLOAD_SIGN_TTL_SECONDS', 60, 3600) ?? RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return {
      endpoint,
      publicEndpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      signedUrlTtlSeconds,
      status: 'configured',
      revision: 0,
      source: 'environment',
    }
  }
  return {
    endpoint,
    publicEndpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    signedUrlTtlSeconds,
    status: 'not_configured',
    revision: 0,
    source: 'environment',
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
  const now = Date.now()
  const revision = await readConfigRevision()
  if (cache && now - cache.at < CACHE_TTL_MS) {
    // Within TTL: serve unless a newer config revision is observable.
    if (revision === null || revision === cache.configRevision) return cache
  }
  const [storage, runtime, templates] = await Promise.all([
    loadStorageSettings(),
    loadRuntimeSettings(),
    loadPromptTemplates(),
  ])
  const next: CacheEntry = {
    configRevision: revision ?? cache?.configRevision ?? -1,
    at: now,
    storage,
    runtime,
    templates,
  }
  cache = next
  return next
}

export async function resolveStorageSettings(): Promise<ResolvedStorageSettings> {
  return (await ensureCache()).storage
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
