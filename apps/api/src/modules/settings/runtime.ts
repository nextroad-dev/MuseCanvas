import {
  db,
  getSiteSettings,
  getSmtpSettings,
  getStorageSettingsRow,
  getRuntimeSettings,
  resolveStorageConfig,
  toStorageSettingsEntity,
} from '@musecanvas/database'
import type {
  SiteSettingsEntity,
  SmtpSettingsEntity,
  StorageSettingsRow,
  RuntimeSettingsEntity,
  ResolvedStorageConfig,
} from '@musecanvas/database'
import { decryptForPurpose } from '@musecanvas/providers'
import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import type {
  SiteSettingsDto,
  SmtpConnectionStatus,
  SmtpSettingsDto,
  SmtpTlsMode,
  StorageConnectionStatus,
  StorageDriverKind,
  StorageSettingsDto,
  RuntimeSettingsDto,
} from '@musecanvas/contracts'

// DB-first runtime resolvers with legacy env fallback and contract defaults.
//
// Source order for every field: onboarding DB singleton first, legacy
// environment variable second, contract default last. Decrypted plaintext
// secrets only ever appear in these internal resolved shapes — read DTOs are
// built via the `*Dto` helpers below, which strip them.

export interface ResolvedSiteSettings {
  siteName: string | null
  siteUrl: string | null
  revision: number
  updatedAt: string
}

export interface ResolvedSmtpSettings {
  host: string | null
  port: number | null
  tlsMode: SmtpTlsMode
  username: string | null
  /** Decrypted plaintext password, or legacy env fallback. Null when none. Never logged. */
  password: string | null
  fromAddress: string | null
  fromName: string | null
  status: SmtpConnectionStatus
  hasSecret: boolean
  secretFingerprint: string | null
  encryptionKeyId: string | null
  revision: number
  updatedAt: string
}

export interface ResolvedStorageSettings {
  driver: StorageDriverKind
  /** Absolute local root from the row (or null). Meaningful for driver 'local'. */
  localRoot: string | null
  /** For driver 's3': server-side endpoint (endpoint, falling back to publicEndpoint). */
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  /** Decrypted plaintext secret, or legacy env fallback. Null when none. Never logged. */
  secretAccessKey: string | null
  signedUrlTtlSeconds: number
  status: StorageConnectionStatus
  hasSecret: boolean
  secretFingerprint: string | null
  encryptionKeyId: string | null
  revision: number
  updatedAt: string
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
  updatedAt: string
}

/**
 * Storage resolves separately from the other groups. An unusable storage config
 * (undecryptable secret, invalid local root) fails only storage consumers, so site,
 * SMTP and runtime reads keep working.
 */
type StorageLoad = { ok: true; value: ResolvedStorageSettings } | { ok: false; error: unknown }

interface SettingsCache {
  revision: number
  loadedAt: number
  site: ResolvedSiteSettings
  smtp: ResolvedSmtpSettings
  storage: StorageLoad
  runtime: ResolvedRuntimeSettings
}

const CACHE_TTL_MS = 30_000
// Other API instances observe saved settings within five seconds; local writes
// call invalidateRuntimeSettings and refresh immediately.
const REVISION_POLL_MS = 5000
const SYNTHETIC_UPDATED_AT = new Date(0).toISOString()
let cache: SettingsCache | null = null
let revisionCheckedAt = 0
let pending: Promise<SettingsCache> | null = null
let epoch = 0

export function invalidateRuntimeSettings(): void {
  cache = null
  revisionCheckedAt = 0
  pending = null
  epoch++
}

function env(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  return value
}

function envInt(name: string, min: number, max: number): number | undefined {
  const raw = env(name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return undefined
  return parsed
}

/** Lenient canonicalization for legacy env origins. Strict validation lives in setup validation. */
function canonicalEnvOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

function decryptSecret(
  ciphertext: string | null | undefined,
  purpose: 'smtp-credentials' | 'object-storage-credentials',
  keyId: string | null | undefined,
): string | null {
  if (!ciphertext) return null
  try {
    return decryptForPurpose(ciphertext, purpose, keyId ?? null)
  } catch {
    return null
  }
}

async function currentRevision(): Promise<number> {
  try {
    const res = await db().query('SELECT config_revision FROM onboarding_state WHERE singleton=true')
    return Number(res.rows[0]?.config_revision ?? 0)
  } catch {
    return 0
  }
}

/**
 * Per-field site resolution: a persisted non-null siteUrl always wins so
 * operator configuration survives, while a NULL site_url (e.g. the singleton
 * row created by migration before onboarding runs) still falls back to the
 * canonical legacy env origin. siteName/revision metadata always come from
 * the persisted row when one exists.
 */
export function resolveSiteFromRowWithLegacyFallback(
  row: SiteSettingsEntity | null,
  oauthRedirectBaseUrl: string | null | undefined,
  publicOrigin: string | null | undefined,
): ResolvedSiteSettings {
  if (row) {
    return {
      siteName: row.siteName,
      siteUrl: row.siteUrl ?? canonicalEnvOrigin(oauthRedirectBaseUrl ?? publicOrigin),
      revision: row.revision,
      updatedAt: row.updatedAt,
    }
  }
  return {
    siteName: null,
    siteUrl: canonicalEnvOrigin(oauthRedirectBaseUrl ?? publicOrigin),
    revision: 1,
    updatedAt: SYNTHETIC_UPDATED_AT,
  }
}

async function loadSite(): Promise<ResolvedSiteSettings> {
  let row: SiteSettingsEntity | null = null
  try {
    row = await getSiteSettings(db())
  } catch {
    row = null
  }
  return resolveSiteFromRowWithLegacyFallback(row, env('OAUTH_REDIRECT_BASE_URL'), env('PUBLIC_ORIGIN'))
}

async function loadSmtp(): Promise<ResolvedSmtpSettings> {
  let row: SmtpSettingsEntity | null = null
  try {
    row = await getSmtpSettings(db())
  } catch {
    row = null
  }
  const tlsRaw = row?.tlsMode ?? env('SMTP_TLS_MODE') ?? 'none'
  const tlsMode: SmtpTlsMode = tlsRaw === 'starttls' || tlsRaw === 'implicit_tls' ? tlsRaw : 'none'
  const host = row?.host ?? env('SMTP_HOST') ?? null
  const password = decryptSecret(row?.passwordCiphertext, 'smtp-credentials', row?.encryptionKeyId)
    ?? env('SMTP_PASSWORD')
    ?? null
  return {
    host,
    port: row?.port ?? envInt('SMTP_PORT', 1, 65535) ?? null,
    tlsMode,
    username: row?.username ?? env('SMTP_USER') ?? null,
    password,
    fromAddress: row?.fromAddress ?? env('SMTP_FROM') ?? null,
    fromName: row?.fromName ?? env('SMTP_FROM_NAME') ?? null,
    status: row?.status ?? (host ? 'configured' : 'not_configured'),
    hasSecret: row ? row.hasSecret : password !== null,
    secretFingerprint: row?.passwordFingerprint ?? null,
    encryptionKeyId: row?.encryptionKeyId ?? null,
    revision: row?.revision ?? 1,
    updatedAt: row?.updatedAt ?? SYNTHETIC_UPDATED_AT,
  }
}

async function loadStorage(): Promise<StorageLoad> {
  let row: StorageSettingsRow | null = null
  try {
    row = await getStorageSettingsRow(db())
  } catch {
    row = null
  }
  let config: ResolvedStorageConfig
  try {
    // The shared resolver owns source selection. A decrypt failure on a usable row
    // throws INVALID_CONFIG here and is never replaced by the environment secret.
    config = resolveStorageConfig({
      row,
      decryptSecret: stored => decryptForPurpose(
        stored.secret_encrypted ?? '',
        'object-storage-credentials',
        stored.encryption_key_id ?? null,
      ),
      env: process.env,
    })
  } catch (error) {
    return { ok: false, error }
  }
  return { ok: true, value: toResolvedStorage(config, row) }
}

function toResolvedStorage(config: ResolvedStorageConfig, row: StorageSettingsRow | null): ResolvedStorageSettings {
  const stored = row ? toStorageSettingsEntity(row) : null
  if (config.driver === 'local') {
    // The S3 fields stay visible so an operator can switch back. They are never used for I/O.
    return {
      driver: 'local',
      localRoot: config.root,
      endpoint: stored?.endpoint ?? null,
      publicEndpoint: stored?.publicEndpoint ?? null,
      region: stored?.region ?? 'us-east-1',
      bucket: stored?.bucket ?? null,
      accessKeyId: stored?.accessKeyId ?? null,
      secretAccessKey: null,
      signedUrlTtlSeconds: config.signedUrlTtlSeconds,
      status: stored?.status ?? 'configured',
      hasSecret: stored?.hasSecret ?? false,
      secretFingerprint: stored?.secretFingerprint ?? null,
      encryptionKeyId: stored?.encryptionKeyId ?? null,
      revision: stored ? stored.revision : 1,
      updatedAt: stored?.updatedAt ?? SYNTHETIC_UPDATED_AT,
    }
  }
  return {
    driver: 's3',
    localRoot: stored?.localRoot ?? null,
    endpoint: config.endpoint,
    publicEndpoint: config.publicEndpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    signedUrlTtlSeconds: config.signedUrlTtlSeconds,
    status: stored?.status ?? (config.configured ? 'configured' : 'not_configured'),
    hasSecret: stored ? stored.hasSecret : config.secretAccessKey !== null,
    secretFingerprint: stored?.secretFingerprint ?? null,
    encryptionKeyId: stored?.encryptionKeyId ?? null,
    revision: stored ? stored.revision : 1,
    updatedAt: stored?.updatedAt ?? SYNTHETIC_UPDATED_AT,
  }
}

async function loadRuntime(): Promise<ResolvedRuntimeSettings> {
  let row: RuntimeSettingsEntity | null = null
  try {
    row = await getRuntimeSettings(db())
  } catch {
    row = null
  }
  return {
    uploadTtlSeconds: row?.uploadTtlSeconds
      ?? envInt('GENERATION_UPLOAD_TTL_SECONDS', 300, 604800)
      ?? RUNTIME_SETTINGS_DEFAULTS.uploadTtlSeconds,
    signedUrlTtlSeconds: row?.signedUrlTtlSeconds
      ?? envInt('GENERATION_UPLOAD_SIGN_TTL_SECONDS', 60, 3600)
      ?? envInt('S3_SIGNED_URL_TTL', 60, 3600)
      ?? RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds,
    maxImageBytes: row?.maxImageBytes ?? RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
    maxTotalBytes: row?.maxTotalBytes ?? RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes,
    maxInputs: row?.maxInputs ?? RUNTIME_SETTINGS_DEFAULTS.maxInputs,
    providerTimeoutMs: row?.providerTimeoutMs ?? RUNTIME_SETTINGS_DEFAULTS.providerTimeoutMs,
    maxOutputBytes: row?.maxOutputBytes ?? RUNTIME_SETTINGS_DEFAULTS.maxOutputBytes,
    jobLeaseMs: row?.jobLeaseMs ?? RUNTIME_SETTINGS_DEFAULTS.jobLeaseMs,
    revision: row?.revision ?? 1,
    updatedAt: row?.updatedAt ?? SYNTHETIC_UPDATED_AT,
  }
}

async function cached(): Promise<SettingsCache> {
  if (cache && Date.now() - revisionCheckedAt < REVISION_POLL_MS && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache
  if (pending) return pending
  const generation = epoch
  const refresh = async (): Promise<SettingsCache> => {
    const revision = await currentRevision()
    let result = cache
    if (!result || result.revision !== revision || Date.now() - result.loadedAt >= CACHE_TTL_MS) {
      const [site, smtp, storage, runtime] = await Promise.all([loadSite(), loadSmtp(), loadStorage(), loadRuntime()])
      result = { revision, loadedAt: Date.now(), site, smtp, storage, runtime }
    }
    // A write can invalidate while an earlier read is in flight. Its old
    // result must neither overwrite the cache nor escape to waiting readers.
    if (generation !== epoch) return cached()
    cache = result
    revisionCheckedAt = Date.now()
    return result
  }
  const work = refresh()
  pending = work
  try { return await work }
  finally { if (pending === work) pending = null }
}

export async function resolveSiteSettings(): Promise<ResolvedSiteSettings> {
  return (await cached()).site
}

/** Canonical public origin with no trailing slash, or '' when unconfigured. Never throws on missing config. */
export async function resolvePublicOrigin(): Promise<string> {
  const site = await resolveSiteSettings()
  return site.siteUrl || ''
}

export async function resolveSmtpSettings(): Promise<ResolvedSmtpSettings> {
  return (await cached()).smtp
}

export async function resolveStorageSettings(): Promise<ResolvedStorageSettings> {
  const storage = (await cached()).storage
  if (!storage.ok) throw storage.error
  return storage.value
}

export async function resolveRuntimeSettings(): Promise<ResolvedRuntimeSettings> {
  return (await cached()).runtime
}

// Redacted read DTOs. Plaintext and ciphertext secrets never leave this module.
export function siteSettingsDto(resolved: ResolvedSiteSettings): SiteSettingsDto {
  return { siteName: resolved.siteName, siteUrl: resolved.siteUrl, revision: resolved.revision, updatedAt: resolved.updatedAt }
}

export function smtpSettingsDto(resolved: ResolvedSmtpSettings): SmtpSettingsDto {
  return {
    host: resolved.host,
    port: resolved.port,
    tlsMode: resolved.tlsMode,
    username: resolved.username,
    fromAddress: resolved.fromAddress,
    fromName: resolved.fromName,
    hasSecret: resolved.hasSecret,
    secretFingerprint: resolved.secretFingerprint,
    encryptionKeyId: resolved.encryptionKeyId,
    status: resolved.status,
    revision: resolved.revision,
    updatedAt: resolved.updatedAt,
  }
}

export function storageSettingsDto(resolved: ResolvedStorageSettings): StorageSettingsDto {
  return {
    driver: resolved.driver,
    localRoot: resolved.localRoot,
    endpoint: resolved.endpoint,
    publicEndpoint: resolved.publicEndpoint,
    region: resolved.region,
    bucket: resolved.bucket,
    accessKeyId: resolved.accessKeyId,
    signedUrlTtlSeconds: resolved.signedUrlTtlSeconds,
    hasSecret: resolved.hasSecret,
    secretFingerprint: resolved.secretFingerprint,
    encryptionKeyId: resolved.encryptionKeyId,
    status: resolved.status,
    revision: resolved.revision,
    updatedAt: resolved.updatedAt,
  }
}

export function runtimeSettingsDto(resolved: ResolvedRuntimeSettings): RuntimeSettingsDto {
  return {
    uploadTtlSeconds: resolved.uploadTtlSeconds,
    signedUrlTtlSeconds: resolved.signedUrlTtlSeconds,
    maxImageBytes: resolved.maxImageBytes,
    maxTotalBytes: resolved.maxTotalBytes,
    maxInputs: resolved.maxInputs,
    providerTimeoutMs: resolved.providerTimeoutMs,
    maxOutputBytes: resolved.maxOutputBytes,
    jobLeaseMs: resolved.jobLeaseMs,
    revision: resolved.revision,
    updatedAt: resolved.updatedAt,
  }
}
