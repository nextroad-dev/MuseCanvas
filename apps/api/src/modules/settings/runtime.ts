import { db, getSiteSettings, getSmtpSettings, getStorageSettings, getRuntimeSettings } from '@musecanvas/database'
import type {
  SiteSettingsEntity,
  SmtpSettingsEntity,
  StorageSettingsEntity,
  RuntimeSettingsEntity,
} from '@musecanvas/database'
import { decryptForPurpose } from '@musecanvas/providers'
import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import type {
  SiteSettingsDto,
  SmtpConnectionStatus,
  SmtpSettingsDto,
  SmtpTlsMode,
  StorageConnectionStatus,
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

interface SettingsCache {
  revision: number
  loadedAt: number
  site: ResolvedSiteSettings
  smtp: ResolvedSmtpSettings
  storage: ResolvedStorageSettings
  runtime: ResolvedRuntimeSettings
}

const CACHE_TTL_MS = 30_000
const SYNTHETIC_UPDATED_AT = new Date(0).toISOString()
let cache: SettingsCache | null = null

export function invalidateRuntimeSettings(): void {
  cache = null
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

async function loadStorage(): Promise<ResolvedStorageSettings> {
  let row: StorageSettingsEntity | null = null
  try {
    row = await getStorageSettings(db())
  } catch {
    row = null
  }
  const bucket = row?.bucket ?? env('S3_BUCKET') ?? null
  const secretAccessKey = decryptSecret(row?.secretCiphertext, 'object-storage-credentials', row?.encryptionKeyId)
    ?? env('S3_SECRET_ACCESS_KEY')
    ?? null
  return {
    endpoint: row?.endpoint ?? env('S3_ENDPOINT') ?? null,
    publicEndpoint: row?.publicEndpoint ?? env('S3_PUBLIC_ENDPOINT') ?? null,
    region: row?.region ?? env('S3_REGION') ?? 'us-east-1',
    bucket,
    accessKeyId: row?.accessKeyId ?? env('S3_ACCESS_KEY_ID') ?? null,
    secretAccessKey,
    signedUrlTtlSeconds: row?.signedUrlTtlSeconds ?? envInt('S3_SIGNED_URL_TTL', 60, 3600) ?? 900,
    status: row?.status ?? (bucket ? 'configured' : 'not_configured'),
    hasSecret: row ? row.hasSecret : secretAccessKey !== null,
    secretFingerprint: row?.secretFingerprint ?? null,
    encryptionKeyId: row?.encryptionKeyId ?? null,
    revision: row?.revision ?? 1,
    updatedAt: row?.updatedAt ?? SYNTHETIC_UPDATED_AT,
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
  const revision = await currentRevision()
  if (cache && cache.revision === revision && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache
  const [site, smtp, storage, runtime] = await Promise.all([loadSite(), loadSmtp(), loadStorage(), loadRuntime()])
  cache = { revision, loadedAt: Date.now(), site, smtp, storage, runtime }
  return cache
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
  return (await cached()).storage
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
