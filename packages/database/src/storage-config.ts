import type { StorageSettingsRow } from './repositories/onboarding'

// Shared, pure storage configuration resolver. The API and the worker both call this
// so they agree on driver choice, endpoint fallbacks, TTL bounds and secret failures.
// No I/O happens here: the caller supplies the singleton row, a decrypt function and
// the environment block. Callers own caching and revision polling.
//
// Source rules:
// - The database row is used only when its status is 'configured' or 'verified'.
//   Otherwise the environment block is used, whatever the row contains.
// - A row that must be used and whose secret cannot be decrypted fails closed with
//   INVALID_CONFIG. It never falls back to the environment secret.
// - Incomplete S3 configuration is not an error. It is reported as configured: false
//   so the setup flow can still read and fill in the missing fields.

export const STORAGE_SIGNED_URL_TTL_MIN_SECONDS = 60
export const STORAGE_SIGNED_URL_TTL_MAX_SECONDS = 3600
/** Mirrors RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds in @musecanvas/contracts. */
export const STORAGE_SIGNED_URL_TTL_DEFAULT_SECONDS = 900

/**
 * Message is always the bare code, matching the worker's job-failure classifier
 * (exact match on 'INVALID_CONFIG'). The human-readable cause is in `reason`.
 */
export class StorageConfigError extends Error {
  readonly code: 'INVALID_CONFIG' = 'INVALID_CONFIG'
  readonly reason: string
  constructor(reason: string) {
    super('INVALID_CONFIG')
    this.name = 'StorageConfigError'
    this.reason = reason
  }
}

export function isStorageConfigError(error: unknown): error is StorageConfigError {
  return error instanceof StorageConfigError
}

export type StorageConfigSource = 'database' | 'environment'

export interface ResolvedS3StorageConfig {
  driver: 's3'
  source: StorageConfigSource
  /** True when endpoint, bucket, access key and secret are all present. */
  configured: boolean
  /** Server-side access endpoint: endpoint, falling back to publicEndpoint. */
  endpoint: string | null
  /** Browser-facing endpoint: publicEndpoint, falling back to endpoint. */
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  /** Decrypted or environment plaintext. Callers must never log or return it. */
  secretAccessKey: string | null
  /** Clamped to 60..3600 seconds. */
  signedUrlTtlSeconds: number
  forcePathStyle: true
  /** Row revision for source 'database', 0 for source 'environment'. */
  revision: number
}

export interface ResolvedLocalStorageConfig {
  driver: 'local'
  source: StorageConfigSource
  configured: true
  /** Absolute directory on the mounted volume. Validated: no '..' segments. */
  root: string
  /** Clamped to 60..3600 seconds. */
  signedUrlTtlSeconds: number
  /** Row revision for source 'database', 0 for source 'environment'. */
  revision: number
}

export type ResolvedStorageConfig = ResolvedS3StorageConfig | ResolvedLocalStorageConfig

export interface StorageConfigInput {
  /** Raw singleton row as stored, or null when the row is absent. */
  row: StorageSettingsRow | null
  /** Decrypts row.secret_encrypted with the row's key id. Any throw becomes INVALID_CONFIG. */
  decryptSecret: (row: StorageSettingsRow) => string
  /** Environment block (process.env or an equivalent). Empty values count as unset. */
  env: Record<string, string | undefined>
}

const LOCAL_ROOT_MAX_LENGTH = 512

function envText(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name]
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Integer clamped to the signed-URL TTL bounds. Non-numeric input yields the default. */
export function clampSignedUrlTtlSeconds(value: unknown): number {
  let parsed = NaN
  if (typeof value === 'number') parsed = value
  else if (typeof value === 'string' && value.trim() !== '') parsed = Number(value)
  if (!Number.isFinite(parsed)) return STORAGE_SIGNED_URL_TTL_DEFAULT_SECONDS
  return Math.min(STORAGE_SIGNED_URL_TTL_MAX_SECONDS, Math.max(STORAGE_SIGNED_URL_TTL_MIN_SECONDS, Math.trunc(parsed)))
}

/**
 * Local storage root must be absolute (POSIX '/' or a Windows drive such as 'D:\')
 * with no '..' segment, and at most 512 characters. Mirrors the CHECK constraint in
 * migration 0040. This is stricter about control characters.
 */
export function validateLocalStorageRoot(root: string): string {
  const problem = (): never => {
    throw new StorageConfigError('local storage root must be an absolute path without ".." segments (max 512 characters)')
  }
  if (root.length === 0 || root.length > LOCAL_ROOT_MAX_LENGTH) problem()
  if (!/^(\/|[A-Za-z]:[\\/])/.test(root)) problem()
  if (/[\u0000-\u001f]/.test(root)) problem()
  if (root.split(/[\\/]/).some(segment => segment === '..')) problem()
  return root
}

function parseDriver(raw: string, source: StorageConfigSource): 's3' | 'local' {
  if (raw === 's3' || raw === 'local') return raw
  throw new StorageConfigError(`unknown storage driver from ${source}`)
}

/**
 * Pure resolution of the effective object-storage configuration.
 * Throws StorageConfigError (code 'INVALID_CONFIG') for an unusable driver, an invalid
 * local root, or an undecryptable secret on a row that must be used. Missing S3 fields
 * do not throw: they produce configured: false.
 */
export function resolveStorageConfig(input: StorageConfigInput): ResolvedStorageConfig {
  const { row, decryptSecret, env } = input
  if (row !== null && (row.status === 'configured' || row.status === 'verified')) {
    const driver = parseDriver(row.storage_driver ?? 's3', 'database')
    if (driver === 'local') {
      return {
        driver: 'local',
        source: 'database',
        configured: true,
        root: validateLocalStorageRoot(row.local_root ?? missingLocalRoot()),
        signedUrlTtlSeconds: clampSignedUrlTtlSeconds(row.signed_url_ttl_seconds),
        revision: Number(row.revision),
      }
    }
    let secret: string | null = null
    if (row.secret_encrypted) {
      try {
        secret = nonEmpty(decryptSecret(row))
      } catch {
        // Fail closed: a configured row with an unreadable secret must not silently use env.
        throw new StorageConfigError('object storage secret cannot be decrypted')
      }
    }
    return buildS3({
      source: 'database',
      endpoint: row.endpoint,
      publicEndpoint: row.public_endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.access_key_id,
      secretAccessKey: secret,
      ttl: row.signed_url_ttl_seconds,
      revision: Number(row.revision),
    })
  }

  const envDriver = parseDriver(envText(env, 'STORAGE_DRIVER') ?? 's3', 'environment')
  const envTtl = envText(env, 'S3_SIGNED_URL_TTL') ?? envText(env, 'GENERATION_UPLOAD_SIGN_TTL_SECONDS')
  if (envDriver === 'local') {
    const root = envText(env, 'STORAGE_LOCAL_ROOT')
    return {
      driver: 'local',
      source: 'environment',
      configured: true,
      root: validateLocalStorageRoot(root ?? missingLocalRoot()),
      signedUrlTtlSeconds: clampSignedUrlTtlSeconds(envTtl),
      revision: 0,
    }
  }
  return buildS3({
    source: 'environment',
    endpoint: envText(env, 'S3_ENDPOINT'),
    publicEndpoint: envText(env, 'S3_PUBLIC_ENDPOINT'),
    region: envText(env, 'S3_REGION'),
    bucket: envText(env, 'S3_BUCKET'),
    accessKeyId: envText(env, 'S3_ACCESS_KEY_ID'),
    secretAccessKey: envText(env, 'S3_SECRET_ACCESS_KEY'),
    ttl: envTtl,
    revision: 0,
  })
}

function missingLocalRoot(): never {
  throw new StorageConfigError('local storage root is not configured')
}

interface S3Fields {
  source: StorageConfigSource
  endpoint: string | null | undefined
  publicEndpoint: string | null | undefined
  region?: string | null
  bucket: string | null | undefined
  accessKeyId: string | null | undefined
  secretAccessKey: string | null
  ttl: unknown
  revision: number
}

function buildS3(fields: S3Fields): ResolvedS3StorageConfig {
  const endpointRaw = nonEmpty(fields.endpoint)
  const publicEndpointRaw = nonEmpty(fields.publicEndpoint)
  const endpoint = endpointRaw ?? publicEndpointRaw
  const publicEndpoint = publicEndpointRaw ?? endpointRaw
  const bucket = nonEmpty(fields.bucket)
  const accessKeyId = nonEmpty(fields.accessKeyId)
  const secretAccessKey = nonEmpty(fields.secretAccessKey)
  return {
    driver: 's3',
    source: fields.source,
    configured: Boolean(endpoint && bucket && accessKeyId && secretAccessKey),
    endpoint,
    publicEndpoint,
    region: nonEmpty(fields.region) ?? 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    signedUrlTtlSeconds: clampSignedUrlTtlSeconds(fields.ttl),
    forcePathStyle: true,
    revision: fields.revision,
  }
}
