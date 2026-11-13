// 前端共享类型：以 `@musecanvas/contracts` 为唯一契约源，只做再导出/收窄；
// 后端投影尚未进入 contracts 的 DTO（session/account/job/asset/admin）在此镜像，
// 字段名与 `apps/api/src/shared/dto.ts` 和 `apps/api/src/modules/library/dto.ts`
// 逐字对齐，等 contracts 补齐后替换为再导出即可（见交付报告中的契约缺口）。

export type {
  // 基础信封与 JSON
  ApiFailure,
  ApiResponse,
  ApiSuccess,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  // 生成词汇
  CreateGenerationRequest,
  GenerationInputItem,
  GenerationInputRole,
  GenerationMode,
  GenerationOutput,
  GenerationPhase,
  ImageGenerationMetadata,
  ImageGenerationOutput,
  JobStatus,
  MediaKind,
  ModelKind,
  VideoGenerationMetadata,
  VideoGenerationOutput,
  // 模型能力与描述符
  BooleanParameterDescriptor,
  EnumParameterDescriptor,
  ImageSizeConstraints,
  ImageSizeParameterDescriptor,
  ImageSizePreset,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  MediaParameterProvenance,
  ModelCapabilities,
  ModelCapabilityFlags,
  NumberParameterDescriptor,
  ParameterControlKind,
  ParameterCrossFieldConstraint,
  ParameterDependency,
  ParameterDescriptor,
  ParameterOption,
  ParameterUiHint,
  PublicModelDto,
  TextParameterDescriptor,
  MediaModelDefaultsDto,
  UpdateMediaModelDefaultsRequest,
  // 画布与 Agent
  AgentMessageDto,
  AgentStreamEvent,
  CanvasAgentApplyRequest,
  CanvasAgentApplyResultDto,
  CanvasAgentConfirmRequest,
  CanvasAgentConfirmResultDto,
  CanvasAgentEditMetadata,
  CanvasAgentEditSelection,
  CanvasAgentHistoryDto,
  CanvasAgentMessageRequest,
  CanvasAgentPendingJobDto,
  CanvasAgentPendingStatus,
  CanvasAgentSceneCommitMode,
  CanvasAgentSettingsDto,
  CanvasAgentStatusDto,
  CanvasAgentStructuredContext,
  CanvasAgentStructuredEditSource,
  CanvasAgentStructuredInputItem,
  CanvasAgentToolCallDto,
  CanvasAgentTurnRecoveryDto,
  CanvasAgentUsageDto,
  CanvasDto,
  CanvasListItemDto,
  CanvasListPageDto,
  CanvasNode,
  CanvasNodeType,
  CanvasOp,
  CanvasScene,
  CreateCanvasRequest,
  UpdateCanvasRequest,
  UpdateCanvasAgentSettingsRequest,
  // 局部修改
  DisplayRect,
  EditRegion,
  EditSelection,
  RenderBox,
  // 插件
  AdminPluginDocsDto,
  AdminPluginDto,
  AdminPluginInstallResult,
  AdminPluginPackageFile,
  AdminPluginPackageMeta,
  AdminPluginScanFinding,
  BuiltinProviderTemplate,
  BuiltinProviderTemplateCredential,
  BuiltinProviderTemplateModel,
  InstalledPluginStatus,
  PluginKind,
  PluginPackageFormat,
  // Setup
  BootstrapCheck,
  BootstrapCheckKey,
  BootstrapCheckStatus,
  BootstrapDiagnostics,
  OnboardingSectionKey,
  OnboardingSectionState,
  OnboardingStatus,
  RuntimeSettingsDto,
  RuntimeSettingsInput,
  SetupClaimInput,
  SetupClaimResult,
  SetupCompletionPayload,
  SetupConfigDto,
  SetupDatabaseStatus,
  SetupStatusResponse,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpConnectionStatus,
  SmtpSettingsDto,
  SmtpSettingsInput,
  SmtpTlsMode,
  StorageConnectionStatus,
  StorageSettingsDto,
  StorageSettingsInput,
  StorageDriverKind,
  DatabaseDriverKind,
  DatabaseDriverDescriptor,
  DatabaseConnectionSummary,
  // Prompt templates
  CreatePromptTemplateEntryInput,
  DeletePromptTemplateEntryResult,
  DeletePromptTemplateSetResult,
  ImportPromptTemplateItem,
  ImportPromptTemplateSetInput,
  ImportPromptTemplateSetResult,
  PromptTemplateEntryDto,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
  PromptTemplateVar,
  RenderPromptTemplateInput,
  RenderPromptTemplateResult,
  UpdatePromptTemplateEntryInput,
} from '@musecanvas/contracts'

export {
  ALLOWED_PROMPT_TEMPLATE_VARS,
  CANVAS_AGENT_SETTINGS_DEFAULTS,
  CANVAS_DEFAULT_TITLE,
  CanvasErrorCode,
  GenerationErrorCode,
  MediaModelErrorCode,
  MASK_INPUT_ROLE,
  ONBOARDING_SECTION_KEYS,
  PromptTemplateErrorCode,
  RUNTIME_SETTINGS_DEFAULTS,
  SETUP_DATABASE_DRIVERS,
  SetupErrorCode,
  applyCanvasOps,
  clampEditSelection,
  displaySelectionToImageSelection,
  editSelectionIsUsable,
  imageContentBox,
  imageSelectionToDisplaySelection,
  isCanvasUuid,
  parseCanvasAgentMessageRequest,
  parseCanvasOps,
  parseCanvasScene,
  parseRectangleRegion,
} from '@musecanvas/contracts'

import type {
  AdminPluginDto,
  AdminPluginScanFinding,
  CanvasDto,
  CanvasListItemDto,
  GenerationOutput,
  ImportPromptTemplateItem,
  JobStatus,
  JsonValue,
  MediaKind,
  ModelKind,
  PluginKind,
  PublicModelDto,
  SmtpSettingsDto,
  StorageSettingsDto,
} from '@musecanvas/contracts'

// ---------------------------------------------------------------------------
// 账户 / 会话
// ---------------------------------------------------------------------------

export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'

/** `GET /api/session` 的 `user` 字段（apps/api/src/shared/dto.ts userDto）。 */
export interface SessionUserDto {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface SessionDto {
  user: SessionUserDto
}

export interface OAuthIdentityDto {
  id: string
  provider: OAuthProvider
  email?: string
  displayName?: string
  avatarUrl?: string
  linkedAt: string
  lastLoginAt?: string
}

/** 账户页聚合视图：`GET /api/session` + `GET /api/account/oauth`。 */
export interface AccountDto {
  user: SessionUserDto
  oauthIdentities: OAuthIdentityDto[]
}

export type OAuthProvider = 'github' | 'google'

/** `GET /api/auth/oauth/providers` 的单项。 */
export interface OAuthProviderInfo {
  provider: OAuthProvider
  label: string
  enabled: boolean
}

/** `POST /api/auth/otp/request` 的 data。 */
export interface OtpRequestResult {
  accepted: boolean
  nextStep: 'otp' | 'invitation'
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 生成台只消费媒体模型（GET /api/models 只返回 image/video）。 */
export type MediaModelDto = PublicModelDto
export type DefaultAwareModel = PublicModelDto & { isDefault?: boolean }

export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

/** 管理端模型行：`apps/api/src/shared/dto.ts modelDto`。 */
export type AdminModelDto = Omit<PublicModelDto, 'modelKind'> & {
  modelKind: ModelKind
  presetId?: string
  languageProtocol?: string
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: string
  vendorModelId: string
  baseUrl: string
  concurrencyLimit: number
  watermark: boolean
  providerCredentialId?: string
  providerCredentialName?: string
  revision?: number
  latestRevisionId?: string
}

export type AdminModelInput = {
  id?: string
  presetId?: string
  pluginId?: string
  pluginVersion?: string
  modelKind?: 'image' | 'video' | 'language'
  providerId?: string
  providerCredentialId?: string | null
  displayName?: string
  vendorModelId?: string
  baseUrl?: string
  concurrencyLimit?: number
  sortOrder?: number
  enabled?: boolean
  watermark?: boolean
  reasoningEffort?: ReasoningEffort
}

export interface ModelPresetDto {
  id: string
  modelKind: ModelKind
  displayName: string
  adapter?: string
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  vendorModelId: string
  baseUrl: string
  concurrencyLimit: number
  languageProtocol?: LanguageProtocol
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
}

// ---------------------------------------------------------------------------
// 生成任务（apps/api/src/shared/dto.ts jobDto）
// ---------------------------------------------------------------------------

export interface GenerationJobModelRef {
  id: string
  name: string
  mediaKind: string
  providerId?: string
  pluginId?: string
  pluginVersion?: string
}

export interface GenerationJobInputDto {
  id: string
  uploadId?: string
  assetId?: string
  source: 'upload' | 'gallery'
  role: string
  position: number
  imageUrl: string
  url: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export interface GenerationJobInputImageDto {
  id: string
  imageUrl: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export interface GenerationJobDto {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  mediaKind: MediaKind
  model?: GenerationJobModelRef
  phase: string | null
  progress?: number
  cancelRequested?: boolean
  title?: string | null
  prompt: string
  inputPrompt?: string
  finalPrompt?: string | null
  canReadFinalPrompt?: boolean
  templateName?: string | null
  optimizationMode?: 'enabled' | 'disabled'
  optimizationStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | null
  parameters?: Record<string, JsonValue>
  size: string | null
  quality?: string
  count?: number
  status: JobStatus
  errorCode?: string
  errorMessage?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  inputs?: GenerationJobInputDto[]
  /** @deprecated 兼容字段，读 `inputs`。 */
  inputImages?: GenerationJobInputImageDto[]
  outputs: GenerationOutput[]
}

export interface GenerationJobListDto {
  items: GenerationJobDto[]
  total: number
  hasMore: boolean
}

export interface JobFilters {
  /** 仅用于客户端筛选；后端 `GET /jobs` 固定返回最近 50 条。 */
  status?: JobStatus | 'active'
  limit?: number
}

// ---------------------------------------------------------------------------
// 图库资产（apps/api/src/modules/library/dto.ts libraryAssetDto）
// ---------------------------------------------------------------------------

export interface AssetDto {
  id: string
  mediaKind: MediaKind
  prompt: string
  inputPrompt?: string
  finalPrompt?: string | null
  canReadFinalPrompt?: boolean
  url: string
  downloadUrl: string
  imageUrl: string
  posterUrl?: string
  posterAssetId?: string
  /** Worker 生成的预览（图片 WebP / 视频 JPEG 首帧），缺失时回落到原图。 */
  thumbnailUrl?: string
  thumbnailMimeType?: string
  thumbnailWidth?: number
  thumbnailHeight?: number
  mimeType: string
  width?: number
  height?: number
  durationSeconds?: number
  fps?: number
  codec?: string
  hasAudio?: boolean
  sizeBytes?: number
  createdAt: string
  /**
   * 灯箱「同一对话里的作品」所需关联。后端 library 查询尚未投影该字段
   * （见 apps/api/src/modules/library/dto.ts），contracts 补齐前保持可选。
   */
  canvasId?: string
}

export interface AssetListDto {
  items: AssetDto[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

/** `GET /api/library/:id/download`。 */
export interface AssetDownloadDto {
  url: string
  downloadUrl: string
  mediaKind: string
  mimeType: string
}

export interface LibraryFilters {
  limit?: number
  q?: string
  kind?: MediaKind
  /** 仅返回可作参考图（PNG/JPEG）的图片。 */
  eligible?: boolean
}

// ---------------------------------------------------------------------------
// 参考图直传（generation-uploads / media 预签名）
// ---------------------------------------------------------------------------

export interface PresignedUploadDto {
  id: string
  uploadUrl: string
  fields: Record<string, string>
  expiresAt: string
}

export interface UploadCompleteDto {
  id: string
  imageUrl: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export type StagedUploadStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'error'
export type StagedInputRole = 'reference_image' | 'first_frame' | 'last_frame' | 'prompt_image' | 'mask'

/** 参考图暂存项：upload 持有远端行，gallery 只引用已有 asset。 */
export interface StagedReferenceImage {
  localId: string
  source: 'upload' | 'gallery'
  file?: File
  previewUrl: string
  status: StagedUploadStatus
  progress: number
  uploadId?: string
  assetId?: string
  imageUrl?: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  error?: string
  role?: StagedInputRole
}

/** 生成参数字段值（描述符声明的 JSON 类型）。 */
export type ParameterValue = string | number | boolean
export type ParameterState = Record<string, ParameterValue>

// ---------------------------------------------------------------------------
// 画布（契约已定义，再导出常用别名）
// ---------------------------------------------------------------------------

export type CanvasDetailDto = CanvasDto
export type CanvasSummaryDto = CanvasListItemDto

// ---------------------------------------------------------------------------
// 管理后台
// ---------------------------------------------------------------------------

export interface AdminDashboardDto {
  totalUsers: number
  totalJobs: number
  failedJobs7d: number
  successRate7d: number
  /**
   * 设计 07 需要「近 7 天每日成功/失败」堆叠柱状图，当前后端未返回。
   * 契约补齐（plan B1）后启用；缺失时页面降级为单指标卡片。
   */
  daily?: Array<{ date: string; succeeded: number; failed: number }>
}

export type AdminUserDto = SessionUserDto

export interface AdminJobDto {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  mediaKind: string
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  phase?: string | null
  progress?: number
  templateName?: string | null
  languageModelName?: string | null
  languageModelVendorId?: string | null
  languageModelProtocol?: string | null
  status: JobStatus
  errorCode?: string
  providerError?: {
    status?: number
    providerReferenceId?: string
    [key: string]: unknown
  }
  providerReferenceId?: string
  durationMs?: number
  createdAt: string
  completedAt?: string
}

export interface InvitationDto {
  id: string
  code?: string
  used: boolean
  revoked?: boolean
  createdAt: string
}

export interface AdminOAuthProviderDto extends OAuthProviderInfo {
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

export type ProviderTestStatus = 'success' | 'failed' | 'not_tested' | 'pending'

export interface ProviderCredentialDto {
  id: string
  displayName: string
  providerId?: string
  schemaId: string
  schemaVersion: number
  /** @deprecated 兼容字段。 */
  adapter?: string
  baseUrl: string
  enabled: boolean
  hasCredential: boolean
  hasApiKey: boolean
  keyFingerprint?: string
  configuredFields: Record<string, unknown>
  lastTestStatus: ProviderTestStatus
  lastTestErrorCode?: string
  lastTestedAt?: string
  updatedAt: string
}

export interface ProviderCredentialInput {
  displayName?: string
  providerId?: string
  pluginId?: string
  pluginVersion?: string
  schemaId?: string
  schemaVersion?: number
  baseUrl?: string
  /** 只写密钥：明文 key 或 JSON 对象。 */
  secret?: string | Record<string, unknown>
  enabled?: boolean
}

export interface PromptOptimizationSettingsDto {
  enabled: boolean
  allowUserReadFinalPrompt: boolean
  languageModelConfigId: string | null
  timeoutMs: number
  updatedAt: string
}

export interface PromptOptimizationSettingsInput {
  enabled?: boolean
  allowUserReadFinalPrompt?: boolean
  languageModelConfigId?: string | null
}

export interface PromptTemplateExportPayload {
  name?: string
  version: number
  templates: ImportPromptTemplateItem[]
}

/** 插件 validate/upload 的平台 422 拒绝形状（envelope 仍为 success:true）。 */
export interface AdminPluginRejected {
  ok: false
  installed: false
  code: string
  findings: AdminPluginScanFinding[]
}

export interface AdminPluginValidateResult {
  ok: true
  pluginId: string
  pluginVersion: string
  kind: PluginKind
  displayName: string
  modelIds: string[]
  allowedHosts: string[]
  artifactDigest: string
  artifactSizeBytes: number
  warnings: AdminPluginScanFinding[]
}

export type AdminPluginUploadResult =
  | { installed: true; plugin: AdminPluginDto; warnings: AdminPluginScanFinding[] }
  | AdminPluginRejected

export interface AdminPluginDeleteResult {
  deleted: boolean
  pinnedRevisionsRetainArtifact: boolean
  note: string
}

export interface AdminPluginDocsResult {
  readme: string | null
  changelog: string | null
  licenseText: string | null
}

// ---------------------------------------------------------------------------
// Setup 向导
// ---------------------------------------------------------------------------

export interface SetupDatabaseTestResult {
  ok: boolean
  errorCode: string | null
  driver: string
  availableDrivers: Array<{ id: string; label: string; available: boolean; reason?: string }>
  connection: { host: string | null; port: number | null; database: string | null; user: string | null }
  serverVersion?: string | null
  schemaVersion?: string | null
  reachable: boolean
}

export interface SetupSmtpTestResult {
  verified: boolean
  settings: SmtpSettingsDto
}

export interface SetupStorageTestResult {
  verified: boolean
  settings: StorageSettingsDto
}

export interface SetupAdminRequestResult {
  accepted: boolean
}

export interface SetupTemplateImportResult {
  imported: boolean
  setId: string
  name: string
  version: number
  entryCount: number
  isActive: boolean
}

export interface RegistrationModeDto {
  requiresInvitation: boolean
}

// ---------------------------------------------------------------------------
// 媒体 helpers（浏览器安全，无 DOM 依赖）
// ---------------------------------------------------------------------------

export function modelMediaKind(model?: { modelKind?: ModelKind; mediaKind?: MediaKind } | null): MediaKind {
  if (!model) return 'image'
  if (model.modelKind === 'video') return 'video'
  if ((model as { mediaKind?: MediaKind }).mediaKind === 'video') return 'video'
  return 'image'
}

export function isVideoModel(model?: { modelKind?: ModelKind; mediaKind?: MediaKind } | null): boolean {
  return modelMediaKind(model) === 'video'
}

export function isVideoOutput(output: GenerationOutput): output is Extract<GenerationOutput, { mediaKind: 'video' }> {
  return output.mediaKind === 'video'
}

export function outputUrl(output: GenerationOutput): string {
  return output.url || ''
}

export function outputPoster(output: GenerationOutput): string | undefined {
  return output.mediaKind === 'video' ? output.metadata.posterUrl || undefined : undefined
}

export function assetPlaybackUrl(asset: Pick<AssetDto, 'url' | 'imageUrl'>): string {
  return asset.url || asset.imageUrl || ''
}

/** 网格/缩略图显示地址：优先 worker 预览图，下载与灯箱仍用原图。 */
export function assetPreviewUrl(asset: Pick<AssetDto, 'thumbnailUrl' | 'url' | 'imageUrl'>): string {
  return asset.thumbnailUrl || asset.url || asset.imageUrl || ''
}

export function isVideoAsset(asset: Pick<AssetDto, 'mediaKind' | 'mimeType' | 'url' | 'imageUrl'>): boolean {
  if (asset.mediaKind === 'video') return true
  const url = asset.url || asset.imageUrl || ''
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return true
  return (asset.mimeType || '').toLowerCase().startsWith('video/')
}


