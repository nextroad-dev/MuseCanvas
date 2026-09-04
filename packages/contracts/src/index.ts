export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]

export type ApiSuccess<T> = { success: true; data: T }
export type ApiFailure = { success: false; error: { code: string; message: string } }
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

// Shared public vocabulary
export type MediaKind = 'image' | 'video'
export type ModelKind = MediaKind | 'language'
export type GenerationMode =
  | 'text_to_image'
  | 'image_to_image'
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
  | (string & {})

export interface GenerationInputItem {
  uploadId: string
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
export interface EnumParameterDescriptor {
  type: 'enum'
  name: string
  label?: string
  description?: string
  required?: boolean
  options: string[]
  defaultValue?: string
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
}

export interface BooleanParameterDescriptor {
  type: 'boolean'
  name: string
  label?: string
  description?: string
  required?: boolean
  defaultValue?: boolean
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
}

export type ParameterDescriptor =
  | EnumParameterDescriptor
  | IntegerParameterDescriptor
  | BooleanParameterDescriptor
  | TextParameterDescriptor

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
}

// Pricing Types
export type PricingScheme = 'per_image_v1' | 'per_second_v1'

export interface ImagePricingV1 {
  scheme: 'per_image_v1'
  creditsPerImage: number
}

export interface VideoPricingV1 {
  scheme: 'per_second_v1'
  creditsPerSecond: number
  minDurationSeconds?: number
  maxDurationSeconds?: number
}

export type ModelPricing = ImagePricingV1 | VideoPricingV1

export interface QuoteMediaGenerationCreditsInput {
  pricing: ModelPricing
  count?: number
  durationSeconds?: number
  optimizationCredits?: number
}

export interface MediaCreditsQuote {
  pricing: ModelPricing
  count: number
  durationSeconds?: number
  baseCredits: number
  optimizationCredits: number
  totalCredits: number
  quotedCredits: number
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
  pricing: ModelPricing
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

// Existing Billing Types (Preserved)
export type BillingState = 'reserved' | 'settled' | 'released'
export type CreditLedgerOperation = 'grant' | 'adjustment' | 'reservation' | 'capture' | 'release'

export interface CreditBalance {
  userId: string
  availableCredits: number
  reservedCredits: number
  totalCredits: number
  updatedAt?: string
}

export interface CreditLedgerEntry {
  id: string
  userId: string
  operation: CreditLedgerOperation
  availableDelta: number
  reservedDelta: number
  availableAfter: number
  reservedAfter: number
  referenceType: string
  referenceId: string
  billingCycle?: number | null
  note?: string | null
  createdAt: string
}

export interface GenerationBilling {
  jobId: string
  userId: string
  state: BillingState
  billingCycle: number
  quotedCredits: number
  pricingSnapshot: GenerationCreditsQuote
  reservedAt?: string | null
  settledAt?: string | null
  releasedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface BillingSettings {
  enabled: boolean
  signupGrant: number
  promptOptimizationCredits: number
  updatedAt?: string
}

export interface QuoteGenerationCreditsInput {
  creditsPerImage: number
  count: number
  optimizationCredits?: number
}

export interface GenerationCreditsQuote {
  creditsPerImage: number
  count: number
  optimizationCredits: number
  imageCredits: number
  totalCredits: number
  quotedCredits: number
}

export const BillingErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  GENERATION_PRICE_CHANGED: 'GENERATION_PRICE_CHANGED',
  BILLING_STATE_CONFLICT: 'BILLING_STATE_CONFLICT',
  INVALID_CREDIT_AMOUNT: 'INVALID_CREDIT_AMOUNT',
} as const

export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode]

export const INSUFFICIENT_CREDITS = BillingErrorCode.INSUFFICIENT_CREDITS
export const GENERATION_PRICE_CHANGED = BillingErrorCode.GENERATION_PRICE_CHANGED
export const BILLING_STATE_CONFLICT = BillingErrorCode.BILLING_STATE_CONFLICT
export const INVALID_CREDIT_AMOUNT = BillingErrorCode.INVALID_CREDIT_AMOUNT

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
