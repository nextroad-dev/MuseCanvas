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
