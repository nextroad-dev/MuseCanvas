// Type-only: `media-parameters.ts` imports these same primitives back from this
// module, and the cycle is erased at compile time because neither direction ever
// needs the other as a value. See the note by the re-exports at the end of file.
import type {
  ImageSizeParameterDescriptor,
  MediaParameterProvenance,
  ModelCapabilityFlags,
  NumberParameterDescriptor,
  ParameterCrossFieldConstraint,
  ParameterDependency,
  ParameterErrorDetails,
  ParameterOption,
  ParameterUiHint,
} from './media-parameters'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]

export type ApiSuccess<T> = { success: true; data: T }
/**
 * `details` lets a validation failure name the offending parameter and value
 * instead of burying them in a sentence, so the client can mark the exact
 * control red rather than show a paragraph. Additive: existing consumers read
 * only `code` and `message`.
 */
export type ApiFailure = {
  success: false
  error: { code: string; message: string; details?: ParameterErrorDetails }
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

// Shared public vocabulary
export type MediaKind = 'image' | 'video'
export type ModelKind = MediaKind | 'language'
export type GenerationMode =
  | 'text_to_image'
  | 'image_to_image'
  /** Image model that also accepts a `mask` input: edit only what it selects. */
  | 'inpaint'
  | 'text_to_video'
  | 'image_to_video'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type GenerationPhase =
  | 'template_selecting'
  | 'template_selected'
  | 'template_skipped'
  | 'template_failed'
  | 'prompt_optimizing'
  | 'prompt_ready'
  | 'optimization_failed'
  | 'preprocessing'
  | 'provider_submitting'
  | 'provider_waiting'
  | 'provider_canceling'
  | 'artifact_importing'
  | 'completed'
  | 'image_generating'
  | 'generation_failed'
  | 'asset_persisting'

export type GenerationInputRole =
  | 'prompt_image'
  | 'reference_image'
  | 'first_frame'
  | 'last_frame'
  | 'source_video'
  /** Alpha PNG marking the region a masked edit may regenerate. */
  | 'mask'
  | (string & {})

/**
 * One input reference. Exactly one of `uploadId` / `assetId` must be present:
 *
 * - `uploadId` — a row in `media_uploads` / `generation_input_images`, i.e. a
 *   locally picked file the browser streamed into object storage. Owned by the
 *   generation: it is marked `attached` and its object is deleted with it.
 * - `assetId` — a row in `assets`, i.e. an image already in the user's gallery.
 *   Referenced, never copied: no upload row and no second object is created, and
 *   the same asset may feed any number of later jobs.
 *
 * Both are uuid-shaped, so one pattern (`GENERATION_UPLOAD_ID_PATTERN`) validates
 * either.
 */
export interface GenerationInputItem {
  uploadId?: string
  assetId?: string
  role: GenerationInputRole
  position: number
}

export interface CreateGenerationRequest {
  modelId: string
  prompt: string
  parameters: Record<string, JsonValue>
  inputs?: GenerationInputItem[]
  idempotencyKey?: string
  inputLanguage?: string
}

// Generation Outputs (Discriminated Union)
export interface ImageGenerationMetadata {
  width?: number
  height?: number
  format?: string
  sizeBytes?: number
  aspectRatio?: string
  seed?: number
  [key: string]: JsonValue | undefined
}

export interface VideoGenerationMetadata {
  width?: number
  height?: number
  durationSeconds?: number
  fps?: number
  format?: string
  codec?: string
  sizeBytes?: number
  aspectRatio?: string
  seed?: number
  hasAudio?: boolean
  posterAssetId?: string
  posterUrl?: string
  [key: string]: JsonValue | undefined
}

export interface ImageGenerationOutput {
  mediaKind: 'image'
  assetId: string
  url: string
  downloadUrl?: string | null
  metadata: ImageGenerationMetadata
}

export interface VideoGenerationOutput {
  mediaKind: 'video'
  assetId: string
  url: string
  downloadUrl?: string | null
  metadata: VideoGenerationMetadata
}

export type GenerationOutput = ImageGenerationOutput | VideoGenerationOutput

// Capabilities & Field Descriptors
//
// These descriptors are the single source of truth for what a media model
// accepts. They are declared by the provider plugin that talks to the vendor and
// consumed unchanged by the browser's parameter UI, the browser's pre-submit
// validation, the API's authoritative validation and the plugin's own request
// adapter — see `media-parameters.ts`. Every field below except `type`/`name` is
// optional so a plugin can state only what it actually knows: an absent
// `defaultValue` is not the same claim as a `defaultValue`.
export interface EnumParameterDescriptor {
  type: 'enum'
  name: string
  label?: string
  description?: string
  required?: boolean
  /**
   * Accepts bare strings and/or rich options. Bare strings are what every
   * persisted `model_config_revisions.capabilities` row stores today, so
   * widening rather than replacing is what keeps old snapshots validating
   * without a rewrite. Read through `normalizeParameterOptions`, never by
   * indexing this array directly.
   */
  options: Array<string | ParameterOption>
  defaultValue?: string
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

export interface IntegerParameterDescriptor {
  type: 'integer'
  name: string
  label?: string
  description?: string
  required?: boolean
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

/**
 * `number` and `image-size` are declared in `media-parameters.ts` alongside
 * their validation, and re-exported from there by the barrel at the end of this
 * file. They are members of `ParameterDescriptor` below, so the union and its
 * exhaustive validator stay in lockstep.
 */

export interface BooleanParameterDescriptor {
  type: 'boolean'
  name: string
  label?: string
  description?: string
  required?: boolean
  defaultValue?: boolean
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

export interface TextParameterDescriptor {
  type: 'text'
  name: string
  label?: string
  description?: string
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  defaultValue?: string
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

export type ParameterDescriptor =
  | EnumParameterDescriptor
  | IntegerParameterDescriptor
  | NumberParameterDescriptor
  | BooleanParameterDescriptor
  | TextParameterDescriptor
  | ImageSizeParameterDescriptor

export interface InputSlotDescriptor {
  role: GenerationInputRole
  required: boolean
  minCount: number
  maxCount: number
  allowedMediaKinds: MediaKind[]
  label?: string
  description?: string
}

export interface ModelCapabilities {
  modes: GenerationMode[]
  parameters: ParameterDescriptor[]
  inputSlots: InputSlotDescriptor[]
  maxCount?: number
  supportedMediaKinds?: MediaKind[]
  /**
   * What the model can be asked to do, as distinct from which knobs it exposes.
   * Consumers gate on `=== true`: an absent flag means unconfirmed, and guessing
   * a capability is exactly the failure this contract exists to prevent.
   */
  flags?: ModelCapabilityFlags
  /** Relational rules evaluated after every single-value check passes. */
  crossFieldConstraints?: ParameterCrossFieldConstraint[]
  /**
   * Who authored this contract. `undeclared` is a hard stop at the API boundary
   * rather than a permissive fallback, so an unknown model surfaces as an admin
   * problem instead of silently accepting arbitrary parameters.
   */
  declaredBy?: MediaParameterProvenance
  deprecated?: boolean
  deprecationNote?: string
}

// Model Configuration Revision & Provider Contracts
export interface ProviderCredentialEnvelope {
  providerId: string
  schemaId: string
  schemaVersion: number | string
  encryptedPayload: string
}

export interface ModelConfigRevision {
  modelId: string
  revision: number
  pluginId: string
  pluginVersion: string
  capabilities: ModelCapabilities
  defaults?: Record<string, JsonValue>
  snapshotDigest: string
}

export type ProviderRunStatus =
  | 'submitting'
  | 'submission_unknown'
  | 'waiting'
  | 'importing'
  | 'canceling'
  | 'succeeded'
  | 'failed'
  | 'canceled'

/**
 * Worker-internal contract. `clientToken`/`leaseToken` are worker lease secrets
 * and MUST NOT be serialized to API clients; project responses through
 * `ProviderRunPublic` instead.
 */
export interface ProviderRun {
  id: string
  jobId: string
  status: ProviderRunStatus
  clientToken: string
  remoteId?: string | null
  stateRevision: number
  nextActionAt?: string | null
  leaseToken?: string | null
  leaseExpiresAt?: string | null
  error?: { code: string; message: string; retryable?: boolean; details?: unknown } | null
}

/** Client-safe projection of `ProviderRun` (strips worker lease secrets). */
export type ProviderRunPublic = Omit<ProviderRun, 'clientToken' | 'leaseToken' | 'leaseExpiresAt'>

// Built-in provider configuration templates. The admin API serves these from
// the provider registry; the browser admin UI mirrors this shape locally.
export interface BuiltinProviderTemplateCredential {
  schemaId: string
  schemaVersion: number
  kind: 'api_key' | 'google_service_account'
  label: string
  placeholder?: string
  helpText?: string
}

export interface BuiltinProviderTemplateModel {
  id: string
  name?: string
}

export interface BuiltinProviderTemplate {
  key: string
  pluginId: string
  pluginVersion: string
  providerId: string
  adapter: string
  displayName: string
  description?: string
  modality: 'image' | 'video'
  baseUrl: string
  credential: BuiltinProviderTemplateCredential
  presetIds: string[]
  models: BuiltinProviderTemplateModel[]
  /**
   * Resolution path for this template, mirroring `model_configs.plugin_source`:
   * 'builtin' ships inside packages/providers, 'installed' is served from an uploaded
   * `provider_plugins` artifact. Omitted on built-in templates for backwards compatibility.
   */
  source?: 'builtin' | 'installed'
}

// ---------------------------------------------------------------------------
// Installed provider plugins (plugin-upload flow)
//
// Admin-facing projection of the `provider_plugins` table. The S3 `object_key` is
// deliberately NOT part of any DTO: the artifact is fetched by the worker only.
// `manifest` is the authoritative listing copy for the API/UI; the worker cross-checks
// the loaded module's own manifest id@version and kind against the row.
// ---------------------------------------------------------------------------

/** Which kernel an uploaded package targets. */
export type PluginKind = 'media' | 'language'

/** Row lifecycle: pending -> active|failed, plus operator-driven disabled. */
export type InstalledPluginStatus = 'pending' | 'active' | 'disabled' | 'failed'

/** One scanner/manifest finding; identical to `PluginScanFinding` in @musecanvas/providers. */
export interface AdminPluginScanFinding {
  rule: string
  severity: 'error' | 'warn'
  line?: number
  column?: number
  message: string
}

export interface AdminPluginDto {
  /** Row uuid, used as the `/admin/plugins/{id}` path segment. */
  id: string
  pluginId: string
  pluginVersion: string
  kind: PluginKind
  displayName: string
  description: string | null
  status: InstalledPluginStatus
  /** Package origin, mirroring `provider_plugins.source` (not the same vocabulary as `BuiltinProviderTemplate.source`). */
  source: 'builtin' | 'uploaded'
  allowedHosts: string[]
  credentialSchemas: string[]
  /** `manifest.modalities` for kind='media'; empty for language rows. */
  modalities: MediaKind[]
  /** `manifest.languageProtocols` for kind='language'; empty for media rows. */
  languageProtocols: string[]
  manifest: JsonObject
  /** sha256 hex of the artifact; the storage object key is never exposed. */
  artifactDigest: string
  artifactSizeBytes: number
  scanReport: AdminPluginScanFinding[]
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

/** Result of a validate/upload call: the stored row plus the non-blocking warnings. */
export interface AdminPluginInstallResult {
  installed: boolean
  plugin: AdminPluginDto
  warnings: AdminPluginScanFinding[]
}

// ---------------------------------------------------------------------------
// Onboarding & setup foundation (contracts-first for the `/setup` flow)
//
// Explicit completion state replaces admin-count completion checks. Secrets are
// write-only: read DTOs expose only hasSecret/fingerprint/status, never
// plaintext or ciphertext.
// ---------------------------------------------------------------------------

export const ONBOARDING_SECTION_KEYS = [
  'bootstrap',
  'site',
  'smtp',
  'admin',
  'storage',
  'providers',
  'models',
  'oauth',
  'templates',
  'runtime',
] as const

export type OnboardingSectionKey = (typeof ONBOARDING_SECTION_KEYS)[number]

export type OnboardingStatus = 'pending' | 'complete'

export type OnboardingSectionStatus = 'pending' | 'complete'

export interface OnboardingSectionState {
  status: OnboardingSectionStatus
  updatedAt: string
}

export interface OnboardingStateSnapshot {
  status: OnboardingStatus
  sections: Record<OnboardingSectionKey, OnboardingSectionState>
  configRevision: number
  completedAt: string | null
  updatedAt: string
}

export type BootstrapCheckKey = 'database' | 'redis' | 'masterKey' | 'runtime'

export type BootstrapCheckStatus = 'ok' | 'missing' | 'error'

export interface BootstrapCheck {
  key: BootstrapCheckKey
  status: BootstrapCheckStatus
  message?: string
}

export interface BootstrapDiagnostics {
  checks: BootstrapCheck[]
  ready: boolean
  checkedAt: string
}

export interface SiteSettingsInput {
  siteName?: string | null
  siteUrl?: string | null
}

export interface SiteSettingsDto {
  siteName: string | null
  siteUrl: string | null
  revision: number
  updatedAt: string
}

export type SmtpTlsMode = 'none' | 'starttls' | 'implicit_tls'

export type SmtpConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

export interface SmtpSettingsInput {
  host?: string | null
  port?: number | null
  tlsMode?: SmtpTlsMode
  username?: string | null
  /** Write-only plaintext secret. Never returned by any read DTO. */
  password?: string | null
  fromAddress?: string | null
  fromName?: string | null
}

export interface SmtpSettingsDto {
  host: string | null
  port: number | null
  tlsMode: SmtpTlsMode
  username: string | null
  fromAddress: string | null
  fromName: string | null
  hasSecret: boolean
  secretFingerprint: string | null
  encryptionKeyId: string | null
  status: SmtpConnectionStatus
  revision: number
  updatedAt: string
}

export type StorageConnectionStatus = 'not_configured' | 'configured' | 'verified' | 'error'

export interface StorageSettingsInput {
  endpoint?: string | null
  publicEndpoint?: string | null
  region?: string | null
  bucket?: string | null
  accessKeyId?: string | null
  /** Write-only plaintext secret. Never returned by any read DTO. */
  secretAccessKey?: string | null
  signedUrlTtlSeconds?: number | null
}

export interface StorageSettingsDto {
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  signedUrlTtlSeconds: number
  hasSecret: boolean
  secretFingerprint: string | null
  encryptionKeyId: string | null
  status: StorageConnectionStatus
  revision: number
  updatedAt: string
}

export const RUNTIME_SETTINGS_DEFAULTS = {
  uploadTtlSeconds: 86400,
  signedUrlTtlSeconds: 900,
  maxImageBytes: 10_000_000,
  maxTotalBytes: 20_000_000,
  maxInputs: 4,
  providerTimeoutMs: 300_000,
  maxOutputBytes: 100_000_000,
  jobLeaseMs: 600_000,
} as const

export interface RuntimeSettingsInput {
  uploadTtlSeconds?: number | null
  signedUrlTtlSeconds?: number | null
  maxImageBytes?: number | null
  maxTotalBytes?: number | null
  maxInputs?: number | null
  providerTimeoutMs?: number | null
  maxOutputBytes?: number | null
  jobLeaseMs?: number | null
}

export interface RuntimeSettingsDto {
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

export interface SetupClaimInput {
  code: string
}

export interface SetupClaimResult {
  claimed: boolean
  expiresAt: string | null
}

export interface SetupCompletionPayload {
  completed: boolean
  completedAt: string | null
  configRevision: number
}

export interface SetupStatusResponse {
  setupComplete: boolean
  status: OnboardingStatus
  sections: Record<OnboardingSectionKey, OnboardingSectionState>
  bootstrap: BootstrapDiagnostics | null
  configRevision: number
  completedAt: string | null
}

export const SetupErrorCode = {
  SETUP_ALREADY_COMPLETE: 'SETUP_ALREADY_COMPLETE',
  SETUP_SESSION_INVALID: 'SETUP_SESSION_INVALID',
  SETUP_SESSION_EXPIRED: 'SETUP_SESSION_EXPIRED',
  SETUP_SESSION_CONSUMED: 'SETUP_SESSION_CONSUMED',
  SETUP_INCOMPLETE: 'SETUP_INCOMPLETE',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_OTP: 'INVALID_OTP',
  RATE_LIMITED: 'RATE_LIMITED',
  EMAIL_DELIVERY_FAILED: 'EMAIL_DELIVERY_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PUBLIC_ORIGIN_INVALID: 'PUBLIC_ORIGIN_INVALID',
  SMTP_TEST_FAILED: 'SMTP_TEST_FAILED',
  STORAGE_TEST_FAILED: 'STORAGE_TEST_FAILED',
} as const

export type SetupErrorCode = (typeof SetupErrorCode)[keyof typeof SetupErrorCode]

// ============================================================================
// Prompt Template Management Contracts
// ============================================================================

export const ALLOWED_PROMPT_TEMPLATE_VARS = [
  'input_prompt',
  'image_model_name',
  'image_adapter',
  'size',
  'quality',
  'count',
  'input_language',
] as const

export type PromptTemplateVar = (typeof ALLOWED_PROMPT_TEMPLATE_VARS)[number]
export const PROMPT_TEMPLATE_VAR_LOOKUP: Readonly<Record<PromptTemplateVar, true>> =
  Object.freeze(Object.fromEntries(
    ALLOWED_PROMPT_TEMPLATE_VARS.map((variable) => [variable, true]),
  ) as Record<PromptTemplateVar, true>)

export interface PromptTemplateEntryDto {
  id: string
  setId: string
  name: string
  description: string
  path?: string
  instruction: string
  contentSha256?: string
  sortOrder: number
  createdAt: string
}

export interface PromptTemplateSetSummaryDto {
  id: string
  name: string
  version: number
  isActive: boolean
  entryCount: number
  contentDigest: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt: string
}

export interface PromptTemplateSetDetailDto extends PromptTemplateSetSummaryDto {
  entries: PromptTemplateEntryDto[]
}

export interface ImportPromptTemplateItem {
  name: string
  description?: string
  instruction: string
  path?: string
  sortOrder?: number
}

export interface ImportPromptTemplateSetInput {
  name?: string
  activate?: boolean
  templates: ImportPromptTemplateItem[]
}

export interface ImportPromptTemplateSetResult {
  imported: boolean
  setId: string
  name: string
  version: number
  entryCount: number
  isActive: boolean
}

export interface CreatePromptTemplateEntryInput {
  name: string
  description?: string
  instruction: string
  sortOrder?: number
}

export interface UpdatePromptTemplateEntryInput {
  name?: string
  description?: string
  instruction?: string
  sortOrder?: number
}
export interface DeletePromptTemplateSetResult {
  deleted: true
}

export interface DeletePromptTemplateEntryResult {
  deleted: true
  setId: string
}


export interface RenderPromptTemplateInput {
  instruction: string
  values?: Record<string, string | number>
}

export interface RenderPromptTemplateResult {
  rendered: string
  usedVariables: string[]
  hasUnresolvedVariables: boolean
}

export const PromptTemplateErrorCode = {
  TEMPLATE_SET_NOT_FOUND: 'TEMPLATE_SET_NOT_FOUND',
  TEMPLATE_ENTRY_NOT_FOUND: 'TEMPLATE_ENTRY_NOT_FOUND',
  TEMPLATE_SET_NOT_ACTIVE: 'TEMPLATE_SET_NOT_ACTIVE',
  CANNOT_DELETE_ACTIVE_SET: 'CANNOT_DELETE_ACTIVE_SET',
  DUPLICATE_TEMPLATE_NAME: 'DUPLICATE_TEMPLATE_NAME',
  INVALID_TEMPLATE_VARIABLE: 'INVALID_TEMPLATE_VARIABLE',
  TEMPLATE_INSTRUCTION_EMPTY: 'TEMPLATE_INSTRUCTION_EMPTY',
  TEMPLATE_NAME_EMPTY: 'TEMPLATE_NAME_EMPTY',
  NO_ACTIVE_TEMPLATE_SET: 'NO_ACTIVE_TEMPLATE_SET',
} as const

export type PromptTemplateErrorCode = (typeof PromptTemplateErrorCode)[keyof typeof PromptTemplateErrorCode]

export * from './endpoints'
export * from './image-edit'
// Media capability metadata and its validator. Loaded last so the type-only
// cycle back into this module never becomes a runtime one.
export * from './media-parameters'
export * from './media-parameter-validation'
