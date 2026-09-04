// Shared types used across the frontend.
//
// Unified image/video vocabulary. The shapes below re-express the shared
// `@musecanvas/contracts` discriminated contracts (MediaKind, ModelKind,
// GenerationOutput, ParameterDescriptor, InputSlotDescriptor, ModelPricing,
// GenerationInputItem) so the browser bundle stays dependency-free. Field
// names and literal values intentionally match the API contract; legacy
// image-only fields are retained as a compatibility path.

export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'retry_wait'
export type RegistrationMode = 'open' | 'invite_only'
export type ModelAdapter = 'openai' | 'seedream' | 'anthropic' | 'veo' | 'volcengine' | 'google' | string
export type MediaKind = 'image' | 'video'
export type ModelKind = 'image' | 'video' | 'language'
export type GenerationMode =
  | 'text_to_image'
  | 'image_to_image'
  | 'text_to_video'
  | 'image_to_video'
export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type Quality = 'low' | 'medium' | 'high' | 'auto'
export type TLSMode = 'implicit_tls' | 'starttls' | 'none'

export interface User {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface Session {
  user: User
}

// ----- Capability / parameter descriptors (mirror contracts) -----

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

export type GenerationInputRole =
  | 'prompt_image'
  | 'reference_image'
  | 'first_frame'
  | 'last_frame'
  | 'source_video'
  | (string & {})

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

export interface ModelConfig {
  id: string
  displayName: string
  adapter: ModelAdapter
  vendorModelId?: string
  // Unified descriptor fields
  modelKind: ModelKind
  /** Legacy alias: image models historically omitted modelKind. */
  mediaKind?: MediaKind
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  modes?: GenerationMode[]
  parameters?: ParameterDescriptor[]
  inputSlots?: InputSlotDescriptor[]
  pricing?: ModelPricing
  defaults?: Record<string, unknown>
  capabilities?: ModelCapabilities
  revision?: number
  // Legacy image compatibility fields
  sizes: string[]
  qualityOptions?: Quality[]
  maxCount: number
  concurrencyLimit: number
  enabled: boolean
  sortOrder: number
  maxInputImages?: number
  creditsPerImage?: number
}

export interface GenerationInputItem {
  uploadId: string
  role: GenerationInputRole
  position: number
}

export interface CreateGenerationRequest {
  modelId: string
  prompt: string
  parameters: Record<string, unknown>
  inputs?: GenerationInputItem[]
  idempotencyKey?: string
  inputLanguage?: string
  expectedCredits?: number
  // Legacy compatibility path (normalized client-side into parameters/inputs)
  size?: string
  quality?: Quality
  count?: number
  inputImageIds?: string[]
}

export interface ImageGenerationMetadata {
  width?: number
  height?: number
  format?: string
  sizeBytes?: number
  aspectRatio?: string
  seed?: number
  [key: string]: unknown
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
  [key: string]: unknown
}

export interface ImageGenerationOutput {
  mediaKind: 'image'
  id: string
  assetId: string
  url: string
  downloadUrl?: string | null
  metadata: ImageGenerationMetadata
  /** Legacy alias for url. */
  imageUrl: string
}

export interface VideoGenerationOutput {
  mediaKind: 'video'
  id: string
  assetId: string
  url: string
  downloadUrl?: string | null
  metadata: VideoGenerationMetadata
  /** Legacy alias for url (compat only; prefer url). */
  imageUrl: string
}

export type GenerationOutput = ImageGenerationOutput | VideoGenerationOutput

export interface GenerationJob {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  title?: string | null
  prompt: string
  inputPrompt?: string
  finalPrompt?: string | null
  canReadFinalPrompt?: boolean
  templateName?: string | null
  phase?: string | null
  progress?: number | null
  mediaKind?: MediaKind | null
  modelKind?: ModelKind | null
  parameters?: Record<string, unknown>
  inputs?: GenerationInputItem[]
  optimizationMode?: 'enabled' | 'disabled'
  optimizationStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | null
  size: string
  quality?: Quality
  count: number
  status: JobStatus
  errorCode?: string
  durationMs?: number
  createdAt: string
  startedAt?: string
  completedAt?: string
  outputs: GenerationOutput[]
  inputImages?: GenerationInputImage[]
  quotedCredits?: number | null
  billingState?: BillingState | null
}

export interface GenerationInputImage {
  id: string
  imageUrl: string
  mimeType: string
  width?: number
  height?: number
  sizeBytes?: number
  role?: GenerationInputRole
  position?: number
}

export type StagedUploadStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'error'

export type StagedInputRole = 'reference_image' | 'first_frame' | 'last_frame' | 'prompt_image'

export interface StagedReferenceImage {
  localId: string
  file: File
  previewUrl: string
  status: StagedUploadStatus
  progress: number
  uploadId?: string
  imageUrl?: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  error?: string
  xhr?: XMLHttpRequest
  /** Input role for unified /api/generations inputs[]. Defaults to reference_image. */
  role?: StagedInputRole
}

export interface PresignedUploadResponse {
  id: string
  uploadUrl: string
  fields: Record<string, string>
  expiresAt: string
}

export interface UploadCompleteResponse {
  id: string
  imageUrl: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export interface Asset {
  id: string
  prompt: string
  inputPrompt?: string
  finalPrompt?: string | null
  canReadFinalPrompt?: boolean
  mediaKind?: MediaKind
  imageUrl: string
  /** Video playback URL (= imageUrl for images). */
  url?: string
  downloadUrl?: string | null
  posterUrl?: string | null
  durationSeconds?: number
  width?: number
  height?: number
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface Invitation {
  id: string
  used: boolean
  revoked?: boolean
  createdAt: string
  code?: string
}

export interface AdminUser {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: string
  credits?: CreditBalance | null
}

export interface AdminModel extends ModelConfig {
  presetId?: string
  modelKind: ModelKind
  languageProtocol?: LanguageProtocol
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  vendorModelId: string
  baseUrl: string
  watermark?: boolean
  providerCredentialId?: string
  providerCredentialName?: string
  capabilitiesJson?: string
  pricingJson?: string
  defaultsJson?: string
}

export type ProviderTestStatus = 'success' | 'failed' | 'not_tested'

export interface ProviderCredentialConfiguredFields {
  pluginId?: string
  pluginVersion?: string
  baseUrl?: string | null
  hasApiKey?: boolean
  apiKeyFingerprint?: string
  legacyFormat?: boolean
  [key: string]: unknown
}

export interface ProviderCredential {
  id: string
  displayName: string
  adapter: ModelAdapter
  providerId?: string
  schemaId?: string
  schemaVersion?: number | string
  baseUrl: string
  enabled: boolean
  hasApiKey: boolean
  hasCredential?: boolean
  keyFingerprint?: string
  credentialFingerprint?: string
  configuredFields?: ProviderCredentialConfiguredFields
  lastTestStatus: ProviderTestStatus
  lastTestErrorCode?: string
  lastTestedAt?: string
  updatedAt: string
}

export interface ProviderCredentialInput {
  displayName?: string
  adapter?: ModelAdapter
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  schemaId?: string
  schemaVersion?: number | string
  baseUrl?: string
  /** Real credential payload (write-only): API key string or service-account object. */
  credential?: string | Record<string, unknown>
  apiKey?: string
  /** Google service-account JSON (write-only) for video providers. */
  serviceAccountJson?: string
  /** Volcengine AK/SK bundle (write-only) for Seedance/volcengine providers. */
  accessKeyId?: string
  secretAccessKey?: string
  /** Generic credential JSON payload (write-only) for plugin providers. */
  credentialJson?: string
  enabled?: boolean
}

export type BuiltinProviderTemplateCredentialKind = 'api_key' | 'google_service_account'

export interface BuiltinProviderTemplateCredential {
  schemaId: string
  schemaVersion: number
  kind: BuiltinProviderTemplateCredentialKind
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

export interface OAuthProviderInfo {
  provider: 'github' | 'google'
  label: string
  enabled: boolean
}

export interface AdminOAuthProvider extends OAuthProviderInfo {
  configuredInDatabase: boolean
  source: 'database' | 'environment' | 'none'
  clientId: string
  hasClientSecret: boolean
  redirectUri: string
}

export interface OAuthProviderInput {
  clientId?: string
  clientSecret?: string
  enabled?: boolean
}

export interface OAuthIdentity {
  provider: 'github' | 'google'
  providerSubject: string
  emailAtLink: string
  displayName?: string
  avatarUrl?: string
  linkedAt: string
  lastLoginAt: string
}

export interface ModelPreset {
  id: string
  modelKind: ModelKind
  displayName: string
  adapter?: ModelAdapter
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  vendorModelId: string
  baseUrl: string
  sizes?: string[]
  qualityOptions?: Quality[]
  maxCount?: number
  maxInputImages?: number
  languageProtocol?: LanguageProtocol
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  concurrencyLimit: number
  watermark?: boolean
  modes?: GenerationMode[]
  parameters?: ParameterDescriptor[]
  inputSlots?: InputSlotDescriptor[]
  capabilities?: ModelCapabilities
  pricing?: ModelPricing
  defaults?: Record<string, unknown>
}

export interface AdminJob {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  phase?: string | null
  templateName?: string | null
  languageModelName?: string | null
  languageModelVendorId?: string | null
  languageModelProtocol?: LanguageProtocol | null
  status: JobStatus
  errorCode?: string
  providerError?: {
    adapter: ModelAdapter
    status: number
    statusText?: string
    endpoint?: string
    detail?: string
    occurredAt?: string
    providerReferenceId?: string
  }
  providerReferenceId?: string
  durationMs?: number
  createdAt: string
  completedAt?: string
  quotedCredits?: number | null
  billingState?: BillingState | null
}

export interface PromptTemplateEntry {
  name: string
  description: string
  path: string
  resolvedPath: string
  fileExists: boolean
  valid: boolean
  errorCode?: string
}

export interface PromptTemplateIndex {
  indexPath: string
  rootDirectory: string
  readable: boolean
  loadedAt: string
  entryCount: number
  valid: boolean
  errorCode?: string
  entries: PromptTemplateEntry[]
}

export interface PromptOptimizationSettings {
  enabled: boolean
  allowUserReadFinalPrompt: boolean
  languageModelConfigId: string | null
  timeoutMs: number
  updatedAt: string
}

export interface DashboardMetrics {
  totalUsers: number
  totalJobs: number
  successRate7d: number
  failedJobs7d: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
}

export interface SetupStatus {
  setupComplete: boolean
}

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
  promptOptimizationEnabled: boolean
  promptOptimizationCredits: number
  updatedAt?: string
}

export interface GenerationCreditsQuote {
  creditsPerImage: number
  count: number
  optimizationCredits: number
  imageCredits: number
  totalCredits: number
}

export interface AdjustCreditsInput {
  amount: number
  note: string
  idempotencyKey: string
}

export interface UpdateBillingSettingsInput {
  enabled?: boolean
  signupGrant?: number
  promptOptimizationCredits?: number
}

export const BillingErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  GENERATION_PRICE_CHANGED: 'GENERATION_PRICE_CHANGED',
  BILLING_STATE_CONFLICT: 'BILLING_STATE_CONFLICT',
  INVALID_CREDIT_AMOUNT: 'INVALID_CREDIT_AMOUNT',
} as const

export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode]

// ----- Media helpers (browser-safe, no DOM) -----

export function modelMediaKind(model?: Pick<ModelConfig, 'modelKind' | 'mediaKind'> | null): MediaKind {
  if (!model) return 'image'
  if (model.modelKind === 'video') return 'video'
  if (model.modelKind === 'language') return 'image'
  if (model.mediaKind === 'video') return 'video'
  return 'image'
}

export function isVideoModel(model?: Pick<ModelConfig, 'modelKind' | 'mediaKind'> | null): boolean {
  return modelMediaKind(model) === 'video'
}

export function outputUrl(output: GenerationOutput): string {
  return output.url || output.imageUrl || ''
}

export function outputPoster(output: GenerationOutput): string | undefined {
  if (output.mediaKind === 'video') return output.metadata.posterUrl || undefined
  return undefined
}

export function isVideoOutput(output: GenerationOutput): output is VideoGenerationOutput {
  return output.mediaKind === 'video'
}

export function assetPlaybackUrl(asset: Pick<Asset, 'url' | 'imageUrl'>): string {
  return asset.url || asset.imageUrl || ''
}

export function isVideoAsset(asset: Pick<Asset, 'mediaKind' | 'mimeType' | 'url' | 'imageUrl'>): boolean {
  if (asset.mediaKind === 'video') return true
  const url = asset.url || asset.imageUrl || ''
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return true
  return (asset.mimeType || '').toLowerCase().startsWith('video/')
}
