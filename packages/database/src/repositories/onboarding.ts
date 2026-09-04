import type pg from 'pg'

// Typed repository for the resumable, secure onboarding foundation.
//
// This module only moves opaque strings and numbers between callers and SQL.
// It performs no encryption, decryption, or fingerprinting: ciphertext and
// fingerprints are caller-supplied and stored opaquely. Plaintext secrets are
// never modeled here and never returned. Depends on `pg` types only — no
// providers/config imports.

export type OnboardingSectionKey =
  | 'bootstrap'
  | 'site'
  | 'smtp'
  | 'admin'
  | 'storage'
  | 'providers'
  | 'models'
  | 'oauth'
  | 'templates'
  | 'runtime'

export type OnboardingStatus = 'pending' | 'complete'
export type OnboardingSectionStatus = 'pending' | 'complete'

// Allow-list for section-status column interpolation. Column names are never
// taken from raw caller input.
const ONBOARDING_SECTION_COLUMNS: Record<OnboardingSectionKey, string> = {
  bootstrap: 'bootstrap_status',
  site: 'site_status',
  smtp: 'smtp_status',
  admin: 'admin_status',
  storage: 'storage_status',
  providers: 'providers_status',
  models: 'models_status',
  oauth: 'oauth_status',
  templates: 'templates_status',
  runtime: 'runtime_status',
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function requireIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

// ---------------------------------------------------------------------------
// Onboarding state snapshot
// ---------------------------------------------------------------------------

export interface OnboardingStateRow {
  status: OnboardingStatus
  bootstrap_status: OnboardingSectionStatus
  site_status: OnboardingSectionStatus
  smtp_status: OnboardingSectionStatus
  admin_status: OnboardingSectionStatus
  storage_status: OnboardingSectionStatus
  providers_status: OnboardingSectionStatus
  models_status: OnboardingSectionStatus
  oauth_status: OnboardingSectionStatus
  templates_status: OnboardingSectionStatus
  runtime_status: OnboardingSectionStatus
  config_revision: number
  completed_at: Date | null
  claim_token_hash: string | null
  claim_expires_at: Date | null
  claim_attempts: number
  claim_consumed_at: Date | null
  updated_at: Date
}

export interface OnboardingSectionState {
  status: OnboardingSectionStatus
  updatedAt: string
}

export interface OnboardingStateEntity {
  status: OnboardingStatus
  sections: Record<OnboardingSectionKey, OnboardingSectionState>
  configRevision: number
  completedAt: string | null
  /** True while an unconsumed one-time claim code is installed. Hash never exposed. */
  hasClaim: boolean
  claimExpiresAt: string | null
  claimAttempts: number
  claimConsumedAt: string | null
  updatedAt: string
}

export function toOnboardingStateEntity(row: OnboardingStateRow): OnboardingStateEntity {
  const updatedAt = requireIso(row.updated_at)
  const section = (status: OnboardingSectionStatus): OnboardingSectionState => ({ status, updatedAt })
  return {
    status: row.status,
    sections: {
      bootstrap: section(row.bootstrap_status),
      site: section(row.site_status),
      smtp: section(row.smtp_status),
      admin: section(row.admin_status),
      storage: section(row.storage_status),
      providers: section(row.providers_status),
      models: section(row.models_status),
      oauth: section(row.oauth_status),
      templates: section(row.templates_status),
      runtime: section(row.runtime_status),
    },
    configRevision: Number(row.config_revision),
    completedAt: toIso(row.completed_at),
    hasClaim: row.claim_token_hash !== null && row.claim_consumed_at === null,
    claimExpiresAt: toIso(row.claim_expires_at),
    claimAttempts: Number(row.claim_attempts ?? 0),
    claimConsumedAt: toIso(row.claim_consumed_at),
    updatedAt,
  }
}

export async function getOnboardingState(
  client: pg.PoolClient | pg.Pool,
): Promise<OnboardingStateEntity | null> {
  const res = await client.query('SELECT * FROM onboarding_state WHERE singleton = true')
  if (!res.rows[0]) return null
  return toOnboardingStateEntity(res.rows[0] as OnboardingStateRow)
}

// ---------------------------------------------------------------------------
// Site settings (app_settings singleton)
// ---------------------------------------------------------------------------

export interface SiteSettingsRow {
  site_name: string | null
  site_url: string | null
  revision: number
  updated_at: Date
}

export interface SiteSettingsEntity {
  siteName: string | null
  siteUrl: string | null
  revision: number
  updatedAt: string
}

export function toSiteSettingsEntity(row: SiteSettingsRow): SiteSettingsEntity {
  return {
    siteName: row.site_name,
    siteUrl: row.site_url,
    revision: Number(row.revision),
    updatedAt: requireIso(row.updated_at),
  }
}

export async function getSiteSettings(
  client: pg.PoolClient | pg.Pool,
): Promise<SiteSettingsEntity | null> {
  const res = await client.query('SELECT * FROM app_settings WHERE singleton = true')
  if (!res.rows[0]) return null
  return toSiteSettingsEntity(res.rows[0] as SiteSettingsRow)
}

export interface UpdateSiteSettingsInput {
  siteName?: string | null
  siteUrl?: string | null
}

export async function updateSiteSettings(
  client: pg.PoolClient | pg.Pool,
  input: UpdateSiteSettingsInput,
  updatedBy?: string | null,
): Promise<SiteSettingsEntity> {
  const current = await client.query('SELECT * FROM app_settings WHERE singleton = true FOR UPDATE')
  const row = current.rows[0] as SiteSettingsRow | undefined
  const res = await client.query(
    `UPDATE app_settings
     SET site_name = $1, site_url = $2, revision = revision + 1,
         updated_at = now(), updated_by = COALESCE($3, updated_by)
     WHERE singleton = true RETURNING *`,
    [
      input.siteName !== undefined ? input.siteName : (row?.site_name ?? null),
      input.siteUrl !== undefined ? input.siteUrl : (row?.site_url ?? null),
      updatedBy ?? null,
    ],
  )
  await markOnboardingSection(client, 'site', 'complete', updatedBy)
  return toSiteSettingsEntity(res.rows[0] as SiteSettingsRow)
}

// ---------------------------------------------------------------------------
// SMTP settings singleton. Ciphertext is opaque; plaintext is never modeled.
// ---------------------------------------------------------------------------

export type SmtpTlsMode = 'none' | 'starttls' | 'implicit_tls'
export type SmtpConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

export interface SmtpSettingsRow {
  host: string | null
  port: number | null
  tls_mode: SmtpTlsMode
  username: string | null
  password_encrypted: string | null
  password_fingerprint: string | null
  encryption_key_id: string | null
  from_address: string | null
  from_name: string | null
  status: SmtpConnectionStatus
  revision: number
  updated_at: Date
}

export interface SmtpSettingsEntity {
  host: string | null
  port: number | null
  tlsMode: SmtpTlsMode
  username: string | null
  fromAddress: string | null
  fromName: string | null
  /** Opaque ciphertext. Never plaintext. */
  passwordCiphertext: string | null
  passwordFingerprint: string | null
  encryptionKeyId: string | null
  hasSecret: boolean
  status: SmtpConnectionStatus
  revision: number
  updatedAt: string
}

export function toSmtpSettingsEntity(row: SmtpSettingsRow): SmtpSettingsEntity {
  return {
    host: row.host,
    port: row.port === null || row.port === undefined ? null : Number(row.port),
    tlsMode: row.tls_mode,
    username: row.username,
    fromAddress: row.from_address,
    fromName: row.from_name,
    passwordCiphertext: row.password_encrypted,
    passwordFingerprint: row.password_fingerprint,
    encryptionKeyId: row.encryption_key_id,
    hasSecret: row.password_encrypted !== null,
    status: row.status,
    revision: Number(row.revision),
    updatedAt: requireIso(row.updated_at),
  }
}

export async function getSmtpSettings(
  client: pg.PoolClient | pg.Pool,
): Promise<SmtpSettingsEntity | null> {
  const res = await client.query('SELECT * FROM smtp_settings WHERE singleton = true')
  if (!res.rows[0]) return null
  return toSmtpSettingsEntity(res.rows[0] as SmtpSettingsRow)
}

export interface UpdateSmtpSettingsInput {
  host?: string | null
  port?: number | null
  tlsMode?: SmtpTlsMode
  username?: string | null
  fromAddress?: string | null
  fromName?: string | null
  status?: SmtpConnectionStatus
  /** Opaque ciphertext supplied by the caller. Omitted = leave unchanged. */
  passwordCiphertext?: string | null
  passwordFingerprint?: string | null
  encryptionKeyId?: string | null
  /** When true, clears the stored ciphertext and fingerprint. */
  clearSecret?: boolean
}

export async function updateSmtpSettings(
  client: pg.PoolClient | pg.Pool,
  input: UpdateSmtpSettingsInput,
  updatedBy?: string | null,
): Promise<SmtpSettingsEntity> {
  const current = await client.query('SELECT * FROM smtp_settings WHERE singleton = true FOR UPDATE')
  const row = current.rows[0] as SmtpSettingsRow | undefined
  const clearSecret = input.clearSecret === true
  const res = await client.query(
    `UPDATE smtp_settings
     SET host = $1, port = $2, tls_mode = $3, username = $4,
         from_address = $5, from_name = $6, status = $7,
         password_encrypted = $8, password_fingerprint = $9, encryption_key_id = $10,
         revision = revision + 1, updated_at = now(),
         updated_by = COALESCE($11, updated_by)
     WHERE singleton = true RETURNING *`,
    [
      input.host !== undefined ? input.host : (row?.host ?? null),
      input.port !== undefined ? input.port : (row?.port ?? null),
      input.tlsMode !== undefined ? input.tlsMode : (row?.tls_mode ?? 'none'),
      input.username !== undefined ? input.username : (row?.username ?? null),
      input.fromAddress !== undefined ? input.fromAddress : (row?.from_address ?? null),
      input.fromName !== undefined ? input.fromName : (row?.from_name ?? null),
      input.status !== undefined ? input.status : (row?.status ?? 'not_configured'),
      clearSecret ? null : (input.passwordCiphertext !== undefined ? input.passwordCiphertext : (row?.password_encrypted ?? null)),
      clearSecret ? null : (input.passwordFingerprint !== undefined ? input.passwordFingerprint : (row?.password_fingerprint ?? null)),
      input.encryptionKeyId !== undefined ? input.encryptionKeyId : (row?.encryption_key_id ?? null),
      updatedBy ?? null,
    ],
  )
  const saved = toSmtpSettingsEntity(res.rows[0] as SmtpSettingsRow)
  await markOnboardingSection(client, 'smtp', saved.status === 'verified' ? 'complete' : 'pending', updatedBy)
  return saved
}

// ---------------------------------------------------------------------------
// Object storage settings singleton. Ciphertext is opaque; never plaintext.
// ---------------------------------------------------------------------------

export type StorageConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

export interface StorageSettingsRow {
  endpoint: string | null
  public_endpoint: string | null
  region: string
  bucket: string | null
  access_key_id: string | null
  secret_encrypted: string | null
  secret_fingerprint: string | null
  encryption_key_id: string | null
  signed_url_ttl_seconds: number
  status: StorageConnectionStatus
  revision: number
  updated_at: Date
}

export interface StorageSettingsEntity {
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  /** Opaque ciphertext. Never plaintext. */
  secretCiphertext: string | null
  secretFingerprint: string | null
  encryptionKeyId: string | null
  signedUrlTtlSeconds: number
  hasSecret: boolean
  status: StorageConnectionStatus
  revision: number
  updatedAt: string
}

export function toStorageSettingsEntity(row: StorageSettingsRow): StorageSettingsEntity {
  return {
    endpoint: row.endpoint,
    publicEndpoint: row.public_endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretCiphertext: row.secret_encrypted,
    secretFingerprint: row.secret_fingerprint,
    encryptionKeyId: row.encryption_key_id,
    signedUrlTtlSeconds: Number(row.signed_url_ttl_seconds),
    hasSecret: row.secret_encrypted !== null,
    status: row.status,
    revision: Number(row.revision),
    updatedAt: requireIso(row.updated_at),
  }
}

export async function getStorageSettings(
  client: pg.PoolClient | pg.Pool,
): Promise<StorageSettingsEntity | null> {
  const res = await client.query('SELECT * FROM object_storage_settings WHERE singleton = true')
  if (!res.rows[0]) return null
  return toStorageSettingsEntity(res.rows[0] as StorageSettingsRow)
}

export interface UpdateStorageSettingsInput {
  endpoint?: string | null
  publicEndpoint?: string | null
  region?: string | null
  bucket?: string | null
  accessKeyId?: string | null
  signedUrlTtlSeconds?: number | null
  status?: StorageConnectionStatus
  /** Opaque ciphertext supplied by the caller. Omitted = leave unchanged. */
  secretCiphertext?: string | null
  secretFingerprint?: string | null
  encryptionKeyId?: string | null
  /** When true, clears the stored ciphertext and fingerprint. */
  clearSecret?: boolean
}

export async function updateStorageSettings(
  client: pg.PoolClient | pg.Pool,
  input: UpdateStorageSettingsInput,
  updatedBy?: string | null,
): Promise<StorageSettingsEntity> {
  const current = await client.query('SELECT * FROM object_storage_settings WHERE singleton = true FOR UPDATE')
  const row = current.rows[0] as StorageSettingsRow | undefined
  const clearSecret = input.clearSecret === true
  const res = await client.query(
    `UPDATE object_storage_settings
     SET endpoint = $1, public_endpoint = $2, region = $3, bucket = $4,
         access_key_id = $5, signed_url_ttl_seconds = $6, status = $7,
         secret_encrypted = $8, secret_fingerprint = $9, encryption_key_id = $10,
         revision = revision + 1, updated_at = now(),
         updated_by = COALESCE($11, updated_by)
     WHERE singleton = true RETURNING *`,
    [
      input.endpoint !== undefined ? input.endpoint : (row?.endpoint ?? null),
      input.publicEndpoint !== undefined ? input.publicEndpoint : (row?.public_endpoint ?? null),
      input.region !== undefined ? input.region : (row?.region ?? 'us-east-1'),
      input.bucket !== undefined ? input.bucket : (row?.bucket ?? null),
      input.accessKeyId !== undefined ? input.accessKeyId : (row?.access_key_id ?? null),
      input.signedUrlTtlSeconds !== undefined ? input.signedUrlTtlSeconds : (row?.signed_url_ttl_seconds ?? 900),
      input.status !== undefined ? input.status : (row?.status ?? 'not_configured'),
      clearSecret ? null : (input.secretCiphertext !== undefined ? input.secretCiphertext : (row?.secret_encrypted ?? null)),
      clearSecret ? null : (input.secretFingerprint !== undefined ? input.secretFingerprint : (row?.secret_fingerprint ?? null)),
      input.encryptionKeyId !== undefined ? input.encryptionKeyId : (row?.encryption_key_id ?? null),
      updatedBy ?? null,
    ],
  )
  const saved = toStorageSettingsEntity(res.rows[0] as StorageSettingsRow)
  await markOnboardingSection(client, 'storage', saved.status === 'verified' ? 'complete' : 'pending', updatedBy)
  return saved
}

// ---------------------------------------------------------------------------
// Runtime settings singleton (numeric tuning moved out of env vars)
// ---------------------------------------------------------------------------

export interface RuntimeSettingsRow {
  upload_ttl_seconds: number
  signed_url_ttl_seconds: number
  max_image_bytes: number
  max_total_bytes: number
  max_inputs: number
  provider_timeout_ms: number
  max_output_bytes: number
  job_lease_ms: number
  revision: number
  updated_at: Date
}

export interface RuntimeSettingsEntity {
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

export function toRuntimeSettingsEntity(row: RuntimeSettingsRow): RuntimeSettingsEntity {
  return {
    uploadTtlSeconds: Number(row.upload_ttl_seconds),
    signedUrlTtlSeconds: Number(row.signed_url_ttl_seconds),
    maxImageBytes: Number(row.max_image_bytes),
    maxTotalBytes: Number(row.max_total_bytes),
    maxInputs: Number(row.max_inputs),
    providerTimeoutMs: Number(row.provider_timeout_ms),
    maxOutputBytes: Number(row.max_output_bytes),
    jobLeaseMs: Number(row.job_lease_ms),
    revision: Number(row.revision),
    updatedAt: requireIso(row.updated_at),
  }
}

export async function getRuntimeSettings(
  client: pg.PoolClient | pg.Pool,
): Promise<RuntimeSettingsEntity | null> {
  const res = await client.query('SELECT * FROM runtime_settings WHERE singleton = true')
  if (!res.rows[0]) return null
  return toRuntimeSettingsEntity(res.rows[0] as RuntimeSettingsRow)
}

export interface UpdateRuntimeSettingsInput {
  uploadTtlSeconds?: number | null
  signedUrlTtlSeconds?: number | null
  maxImageBytes?: number | null
  maxTotalBytes?: number | null
  maxInputs?: number | null
  providerTimeoutMs?: number | null
  maxOutputBytes?: number | null
  jobLeaseMs?: number | null
}

export async function updateRuntimeSettings(
  client: pg.PoolClient | pg.Pool,
  input: UpdateRuntimeSettingsInput,
  updatedBy?: string | null,
): Promise<RuntimeSettingsEntity> {
  const current = await client.query('SELECT * FROM runtime_settings WHERE singleton = true FOR UPDATE')
  const row = current.rows[0] as RuntimeSettingsRow | undefined
  const res = await client.query(
    `UPDATE runtime_settings
     SET upload_ttl_seconds = $1, signed_url_ttl_seconds = $2,
         max_image_bytes = $3, max_total_bytes = $4, max_inputs = $5,
         provider_timeout_ms = $6, max_output_bytes = $7, job_lease_ms = $8,
         revision = revision + 1, updated_at = now(),
         updated_by = COALESCE($9, updated_by)
     WHERE singleton = true RETURNING *`,
    [
      input.uploadTtlSeconds ?? row?.upload_ttl_seconds ?? 86400,
      input.signedUrlTtlSeconds ?? row?.signed_url_ttl_seconds ?? 900,
      input.maxImageBytes ?? row?.max_image_bytes ?? 10000000,
      input.maxTotalBytes ?? row?.max_total_bytes ?? 20000000,
      input.maxInputs ?? row?.max_inputs ?? 4,
      input.providerTimeoutMs ?? row?.provider_timeout_ms ?? 300000,
      input.maxOutputBytes ?? row?.max_output_bytes ?? 100000000,
      input.jobLeaseMs ?? row?.job_lease_ms ?? 600000,
      updatedBy ?? null,
    ],
  )
  await markOnboardingSection(client, 'runtime', 'complete', updatedBy)
  return toRuntimeSettingsEntity(res.rows[0] as RuntimeSettingsRow)
}

// ---------------------------------------------------------------------------
// Shared configuration revision + section status
// ---------------------------------------------------------------------------

export async function bumpConfigRevision(
  client: pg.PoolClient | pg.Pool,
): Promise<number> {
  const res = await client.query(
    `UPDATE onboarding_state
     SET config_revision = config_revision + 1, updated_at = now()
     WHERE singleton = true RETURNING config_revision`,
  )
  return Number(res.rows[0]?.config_revision ?? 0)
}

export async function markOnboardingSection(
  client: pg.PoolClient | pg.Pool,
  section: OnboardingSectionKey,
  status: OnboardingSectionStatus,
  updatedBy?: string | null,
): Promise<OnboardingStateEntity> {
  const column = ONBOARDING_SECTION_COLUMNS[section]
  if (!column) throw new Error('INVALID_ONBOARDING_SECTION')
  const res = await client.query(
    `UPDATE onboarding_state
     SET ${column} = $1, config_revision = config_revision + 1,
         updated_at = now(), updated_by = COALESCE($2, updated_by)
     WHERE singleton = true RETURNING *`,
    [status, updatedBy ?? null],
  )
  if (!res.rows[0]) throw new Error('ONBOARDING_STATE_MISSING')
  return toOnboardingStateEntity(res.rows[0] as OnboardingStateRow)
}

// ---------------------------------------------------------------------------
// Setup sessions (single-use, hashed tokens)
// ---------------------------------------------------------------------------

export interface SetupSessionRow {
  id: string
  token_hash: string
  expires_at: Date
  consumed_at: Date | null
  created_at: Date
}

export interface SetupSessionEntity {
  id: string
  tokenHash: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export function toSetupSessionEntity(row: SetupSessionRow): SetupSessionEntity {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    expiresAt: requireIso(row.expires_at),
    consumedAt: toIso(row.consumed_at),
    createdAt: requireIso(row.created_at),
  }
}

export interface CreateSetupSessionInput {
  /** Hash of the raw single-use token. The raw token is never stored. */
  tokenHash: string
  expiresInSeconds: number
}

export async function createSetupSession(
  client: pg.PoolClient | pg.Pool,
  input: CreateSetupSessionInput,
): Promise<SetupSessionEntity> {
  const res = await client.query(
    `INSERT INTO setup_sessions(token_hash, expires_at)
     VALUES($1, now() + ($2 * interval '1 second')) RETURNING *`,
    [input.tokenHash, input.expiresInSeconds],
  )
  return toSetupSessionEntity(res.rows[0] as SetupSessionRow)
}

export async function getValidSetupSession(
  client: pg.PoolClient | pg.Pool,
  tokenHash: string,
): Promise<SetupSessionEntity | null> {
  const res = await client.query(
    `SELECT * FROM setup_sessions
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash],
  )
  if (!res.rows[0]) return null
  return toSetupSessionEntity(res.rows[0] as SetupSessionRow)
}

export async function consumeSetupSession(
  client: pg.PoolClient | pg.Pool,
  tokenHash: string,
): Promise<SetupSessionEntity | null> {
  const res = await client.query(
    `UPDATE setup_sessions SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING *`,
    [tokenHash],
  )
  if (!res.rows[0]) return null
  return toSetupSessionEntity(res.rows[0] as SetupSessionRow)
}

// ---------------------------------------------------------------------------
// One-time setup claim code. Only the hash is stored; plaintext is never
// modeled. After the claim is consumed, the caller creates a separate
// hashed-cookie setup session via createSetupSession.
// ---------------------------------------------------------------------------

export const DEFAULT_SETUP_CLAIM_MAX_ATTEMPTS = 5

export interface InstallSetupClaimInput {
  /** Hash of the one-time claim code. The raw code is never stored. */
  tokenHash: string
  expiresInSeconds: number
}

export async function installSetupClaim(
  client: pg.PoolClient | pg.Pool,
  input: InstallSetupClaimInput,
  updatedBy?: string | null,
): Promise<OnboardingStateEntity> {
  const res = await client.query(
    `UPDATE onboarding_state
     SET claim_token_hash = $1, claim_expires_at = now() + ($2 * interval '1 second'),
         claim_attempts = 0, claim_consumed_at = NULL,
         updated_at = now(), updated_by = COALESCE($3, updated_by)
     WHERE singleton = true RETURNING *`,
    [input.tokenHash, input.expiresInSeconds, updatedBy ?? null],
  )
  if (!res.rows[0]) throw new Error('ONBOARDING_STATE_MISSING')
  return toOnboardingStateEntity(res.rows[0] as OnboardingStateRow)
}

export async function verifyAndConsumeSetupClaim(
  client: pg.PoolClient | pg.Pool,
  tokenHash: string,
  maxAttempts: number = DEFAULT_SETUP_CLAIM_MAX_ATTEMPTS,
): Promise<OnboardingStateEntity | null> {
  const res = await client.query(
    `UPDATE onboarding_state
     SET claim_consumed_at = now(), updated_at = now()
     WHERE singleton = true AND claim_token_hash = $1
       AND claim_consumed_at IS NULL AND claim_expires_at > now()
       AND claim_attempts < $2
     RETURNING *`,
    [tokenHash, maxAttempts],
  )
  if (res.rows[0]) return toOnboardingStateEntity(res.rows[0] as OnboardingStateRow)
  await client.query(
    `UPDATE onboarding_state SET claim_attempts = claim_attempts + 1, updated_at = now()
     WHERE singleton = true AND claim_consumed_at IS NULL AND claim_expires_at > now()`,
  )
  return null
}

// ---------------------------------------------------------------------------
// Versioned prompt templates (read side for setup + runtime selection)
// ---------------------------------------------------------------------------

export interface PromptTemplateSetRow {
  id: string
  name: string
  version: number
  is_active: boolean
  index_path: string | null
  entry_count: number
  content_digest: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export interface PromptTemplateSetEntity {
  id: string
  name: string
  version: number
  isActive: boolean
  indexPath: string | null
  entryCount: number
  contentDigest: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export function toPromptTemplateSetEntity(row: PromptTemplateSetRow): PromptTemplateSetEntity {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    isActive: row.is_active,
    indexPath: row.index_path,
    entryCount: Number(row.entry_count),
    contentDigest: row.content_digest,
    createdBy: row.created_by ?? null,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  }
}

export interface PromptTemplateEntryRow {
  id: string
  set_id: string
  name: string
  description: string
  path: string
  content_sha256: string | null
  instruction: string | null
  sort_order: number
  created_at: Date
}

export interface PromptTemplateEntryEntity {
  id: string
  setId: string
  name: string
  description: string
  path: string
  contentSha256: string | null
  instruction: string | null
  sortOrder: number
  createdAt: string
}

export function toPromptTemplateEntryEntity(row: PromptTemplateEntryRow): PromptTemplateEntryEntity {
  return {
    id: row.id,
    setId: row.set_id,
    name: row.name,
    description: row.description,
    path: row.path,
    contentSha256: row.content_sha256,
    instruction: row.instruction,
    sortOrder: Number(row.sort_order),
    createdAt: requireIso(row.created_at),
  }
}

export async function getActivePromptTemplateSet(
  client: pg.PoolClient | pg.Pool,
): Promise<PromptTemplateSetEntity | null> {
  const res = await client.query(
    `SELECT * FROM prompt_template_sets
     WHERE is_active = true ORDER BY version DESC LIMIT 1`,
  )
  if (!res.rows[0]) return null
  return toPromptTemplateSetEntity(res.rows[0] as PromptTemplateSetRow)
}

export async function listPromptTemplateEntries(
  client: pg.PoolClient | pg.Pool,
  setId: string,
): Promise<PromptTemplateEntryEntity[]> {
  const res = await client.query(
    `SELECT * FROM prompt_template_entries
     WHERE set_id = $1 ORDER BY sort_order ASC, name ASC`,
    [setId],
  )
  return (res.rows as PromptTemplateEntryRow[]).map(toPromptTemplateEntryEntity)
}

// ---------------------------------------------------------------------------
// Transaction-scoped final completion check.
//
// MUST run inside a transaction: the state row is locked, every required
// section must be complete, and an active admin must exist before status flips
// to complete. Only bootstrap/site/smtp/admin/storage/runtime gate completion;
// providers/models/oauth/templates are optional and may remain pending.
// The flip is one-way — this function never moves complete back to pending,
// so completed status survives later admin deletions.
// ---------------------------------------------------------------------------

export const REQUIRED_COMPLETION_SECTIONS: OnboardingSectionKey[] = [
  'bootstrap',
  'site',
  'smtp',
  'admin',
  'storage',
  'runtime',
]

export interface CompletionCheckResult {
  completed: boolean
  state: OnboardingStateEntity
}

export async function tryCompleteOnboarding(
  client: pg.PoolClient,
): Promise<CompletionCheckResult> {
  const stateRes = await client.query(
    'SELECT * FROM onboarding_state WHERE singleton = true FOR UPDATE',
  )
  if (!stateRes.rows[0]) throw new Error('ONBOARDING_STATE_MISSING')
  const state = toOnboardingStateEntity(stateRes.rows[0] as OnboardingStateRow)
  if (state.status === 'complete') return { completed: true, state }

  const sectionsComplete = REQUIRED_COMPLETION_SECTIONS
    .every((key) => state.sections[key].status === 'complete')
  if (!sectionsComplete) return { completed: false, state }

  const adminRes = await client.query(
    "SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LIMIT 1",
  )
  if (!adminRes.rows[0]) return { completed: false, state }

  const doneRes = await client.query(
    `UPDATE onboarding_state
     SET status = 'complete', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE singleton = true AND status = 'pending' RETURNING *`,
  )
  const next = toOnboardingStateEntity(doneRes.rows[0] as OnboardingStateRow)
  return { completed: true, state: next }
}
