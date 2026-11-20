'use client'

// 浏览器端 typed API。只在 Client Component / 'use client' hook 中引用；
// 路径全部来自 `@musecanvas/contracts` 的 `API_ENDPOINTS`，错误统一抛 `ApiError`。

import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  AdminPluginDocsDto,
  AgentApprovalSummaryDTO,
  AgentArtifactDTO,
  AgentArtifactPageDTO,
  AgentArtifactThreadsPageDTO,
  AgentArtifactThreadDTO,
  CreateAgentArtifactThreadRequest,
  CreateAgentArtifactReplyRequest,
  ResolveAgentArtifactThreadRequest,
  AgentDecimal,
  AgentItemsPageDTO,
  AgentMessageAcceptedDTO,
  AgentEditPreparationDTO,
  PrepareAgentImageEditRequest,
  AgentSessionDTO,
  AgentSessionSnapshotDTO,
  AgentSessionsPageDTO,
  AgentTurnDTO,
  CreateAgentMessageRequest,
  CreateAgentSessionRequest,
  CreatePromptTemplateEntryInput,
  EditSelection,
  ImportPromptTemplateSetInput,
  ImportPromptTemplateSetResult,
  MediaModelDefaultsDto,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
  PublicModelDto,
  RenderPromptTemplateInput,
  RenderPromptTemplateResult,
  ResolveAgentApprovalRequest,
  SetupClaimInput,
  SetupClaimResult,
  SetupCompletionPayload,
  SetupConfigDto,
  SetupDatabaseStatus,
  SetupStatusResponse,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpSettingsDto,
  SmtpSettingsInput,
  StorageSettingsDto,
  StorageSettingsInput,
  RuntimeSettingsDto,
  RuntimeSettingsInput,
  UpdateMediaModelDefaultsRequest,
  UpdatePromptTemplateEntryInput,
  BuiltinProviderTemplate,
} from '@musecanvas/contracts'
import { ApiError, apiFetch, resolveApiUrl } from './api'
import { WORKSPACE_MODE } from '../lib/workspace-mode'
import { mockAgentApi } from './mock-agent-api'
import { mockWorkspaceApi } from './mock-workspace-api'
import type {
  AccountDto,
  AdminDashboardDto,
  AdminJobDto,
  AdminModelDto,
  AdminModelInput,
  AdminOAuthProviderDto,
  AdminPluginDeleteResult,
  AdminPluginDto,
  AdminPluginUploadResult,
  AdminPluginValidateResult,
  AdminUserDto,
  AssetDownloadDto,
  AssetDto,
  AssetListDto,
  AuthSessionResult,
  GenerationJobDto,
  GenerationJobListDto,
  InvitationDto,
  ModelPresetDto,
  OAuthIdentityDto,
  OAuthProvider,
  OAuthProviderInfo,
  OAuthProviderInput,
  OtpRequestResult,
  PresignedUploadDto,
  PromptOptimizationSettingsDto,
  PromptOptimizationSettingsInput,
  ProviderCredentialDto,
  ProviderCredentialInput,
  RegistrationModeDto,
  SessionDto,
  SetupAdminRequestResult,
  SetupDatabaseTestResult,
  SetupSmtpTestResult,
  SetupStorageTestResult,
  SetupTemplateImportResult,
  UploadCompleteDto,
} from '@/shared/types'

export { ApiError, isApiError } from './api'
export { resolveApiUrl }

async function get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  return apiFetch<T>(path, { params })
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body })
}

async function patch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body })
}

async function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// session / auth / account
// ---------------------------------------------------------------------------

export const sessionApi = {
  get: () => get<SessionDto>(API_ENDPOINTS.session),
}

export const authApi = {
  requestOtp: (email: string, invitationCode?: string) =>
    post<OtpRequestResult>(API_ENDPOINTS.auth.otpRequest, {
      email,
      ...(invitationCode ? { invitationCode } : {}),
    }),
  verifyOtp: (email: string, code: string) =>
    post<AuthSessionResult>(API_ENDPOINTS.auth.otpVerify, { email, code }),
  logout: () => post<{ loggedOut: boolean }>(API_ENDPOINTS.auth.logout),
  /** OAuth 登录/绑定的浏览器跳转地址（后端 302 到供应商）。 */
  oauthStartUrl: (provider: OAuthProvider) =>
    WORKSPACE_MODE === 'mock' ? '#' : resolveApiUrl(API_ENDPOINTS.auth.oauthStart(provider)),
  getOAuthProviders: async (): Promise<OAuthProviderInfo[]> => {
    const result = await get<{ providers: OAuthProviderInfo[] }>(API_ENDPOINTS.auth.oauthProviders)
    return result.providers
  },
  /** 邀请制下 OAuth 新用户补邀请码（challengeId 来自 /login 回调 query）。 */
  completeOAuthInvitation: (challengeId: string, invitationCode: string) =>
    post<AuthSessionResult>(API_ENDPOINTS.auth.oauthInvitation, { challengeId, invitationCode }),
}

export const accountApi = {
  get: async (): Promise<AccountDto> => {
    const [session, oauthIdentities] = await Promise.all([
      sessionApi.get(),
      get<OAuthIdentityDto[]>(API_ENDPOINTS.account.oauth),
    ])
    return { user: session.user, oauthIdentities }
  },
  getOAuthIdentities: () => get<OAuthIdentityDto[]>(API_ENDPOINTS.account.oauth),
  oauthLinkUrl: (provider: OAuthProvider) =>
    WORKSPACE_MODE === 'mock' ? '#' : resolveApiUrl(API_ENDPOINTS.account.oauthLinkStart(provider)),
  unlinkOAuth: (provider: OAuthProvider) =>
    del<{ unlinked: boolean }>(API_ENDPOINTS.account.oauthUnlink(provider)),
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

export const modelsApi = {
  list: () => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.models.list() : get<PublicModelDto[]>(API_ENDPOINTS.models),
}

// ---------------------------------------------------------------------------
// agent core v1
// ---------------------------------------------------------------------------

// Mock workspace has no durable Artifact projection; never fall through to live IO.
function mockArtifactUnavailable<T>(): Promise<T> {
  return Promise.reject(new Error('本地演示暂无持久化 Artifact，请使用真实会话。'))
}

export const agentApi = {
  listArtifacts: (sessionId: string, params?: { limit?: number; cursor?: string }): Promise<AgentArtifactPageDTO> =>
    WORKSPACE_MODE === 'mock'
      ? Promise.resolve({ items: [], nextCursor: null })
      : get<AgentArtifactPageDTO>(API_ENDPOINTS.agent.artifacts(sessionId), params),
  getArtifact: (sessionId: string, artifactId: string): Promise<AgentArtifactDTO> =>
    WORKSPACE_MODE === 'mock'
      ? mockArtifactUnavailable()
      : get<AgentArtifactDTO>(API_ENDPOINTS.agent.artifact(sessionId, artifactId)),
  listArtifactThreads: (sessionId: string, artifactId: string, params?: { limit?: number; cursor?: string }): Promise<AgentArtifactThreadsPageDTO> =>
    WORKSPACE_MODE === 'mock'
      ? Promise.resolve({ items: [], nextCursor: null })
      : get<AgentArtifactThreadsPageDTO>(API_ENDPOINTS.agent.artifactThreads(sessionId, artifactId), params),
  createArtifactThread: (sessionId: string, artifactId: string, body: CreateAgentArtifactThreadRequest): Promise<AgentArtifactThreadDTO> =>
    WORKSPACE_MODE === 'mock'
      ? mockArtifactUnavailable()
      : post<AgentArtifactThreadDTO>(API_ENDPOINTS.agent.artifactThreads(sessionId, artifactId), body),
  resolveArtifactThread: (sessionId: string, artifactId: string, threadId: string, body: ResolveAgentArtifactThreadRequest): Promise<AgentArtifactThreadDTO> =>
    WORKSPACE_MODE === 'mock'
      ? mockArtifactUnavailable()
      : patch<AgentArtifactThreadDTO>(API_ENDPOINTS.agent.artifactThread(sessionId, artifactId, threadId), body),
  replyArtifactThread: (sessionId: string, artifactId: string, threadId: string, body: CreateAgentArtifactReplyRequest): Promise<AgentArtifactThreadDTO> =>
    WORKSPACE_MODE === 'mock'
      ? mockArtifactUnavailable()
      : post<AgentArtifactThreadDTO>(API_ENDPOINTS.agent.artifactThreadReplies(sessionId, artifactId, threadId), body),
  listSessions: (params?: { limit?: number; cursor?: string }) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.listSessions(params)
      : get<AgentSessionsPageDTO>(API_ENDPOINTS.agent.sessions, params),
  createSession: (body: CreateAgentSessionRequest) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.createSession(body)
      : post<AgentSessionDTO>(API_ENDPOINTS.agent.sessions, body),
  getSnapshot: (sessionId: string, params?: { limit?: number }) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.getSnapshot(sessionId, params)
      : get<AgentSessionSnapshotDTO>(API_ENDPOINTS.agent.session(sessionId), params),
  listItems: (sessionId: string, params?: { cursor?: AgentDecimal; limit?: number }) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.listItems(sessionId, params)
      : get<AgentItemsPageDTO>(API_ENDPOINTS.agent.items(sessionId), params),
  sendMessage: (sessionId: string, body: CreateAgentMessageRequest) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.sendMessage(sessionId, body)
      : post<AgentMessageAcceptedDTO>(API_ENDPOINTS.agent.messages(sessionId), body),
  steerTurn: (turnId: string, body: CreateAgentMessageRequest) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.steerTurn(turnId, body)
      : post<AgentMessageAcceptedDTO>(API_ENDPOINTS.agent.steer(turnId), body),
  getTurn: (turnId: string) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.getTurn(turnId)
      : get<AgentTurnDTO>(API_ENDPOINTS.agent.turn(turnId)),
  cancelTurn: (turnId: string) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.cancelTurn(turnId)
      : post<AgentTurnDTO>(API_ENDPOINTS.agent.cancel(turnId), {}),
  resolveApproval: (approvalId: string, body: ResolveAgentApprovalRequest) =>
    WORKSPACE_MODE === 'mock'
      ? mockAgentApi.resolveApproval(approvalId, body)
      : post<AgentApprovalSummaryDTO>(API_ENDPOINTS.agent.resolveApproval(approvalId), body),
  prepareImageEdit: (input: Omit<PrepareAgentImageEditRequest, 'region' | 'idempotencyKey'> & {
    image?: File
    selection?: EditSelection
    mask?: File
    idempotencyKey: string
  }) => {
    if (Boolean(input.assetId) === Boolean(input.image)) {
      throw new Error('局部修改必须且只能提供一个图库资产或源图片。')
    }
    if (Boolean(input.selection) === Boolean(input.mask)) {
      throw new Error('局部修改必须且只能提供一个选区或蒙版。')
    }
    if (input.turnId && !input.sessionId) throw new Error('已受理轮次必须同时提供所属会话。')
    const form = new FormData()
    form.append('modelId', input.modelId)
    if (input.sessionId) form.append('sessionId', input.sessionId)
    if (input.turnId) form.append('turnId', input.turnId)
    if (input.assetId) form.append('assetId', input.assetId)
    if (input.image) form.append('image', input.image, input.image.name)
    if (input.selection) form.append('region', JSON.stringify(input.selection))
    if (input.mask) form.append('mask', input.mask, input.mask.name)
    form.append('idempotencyKey', input.idempotencyKey)
    return apiFetch<AgentEditPreparationDTO>(API_ENDPOINTS.images.prepareEdit, { method: 'POST', body: form })
  },
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export const jobsApi = {
  list: (params?: { status?: string }) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.jobs.list(params) : get<GenerationJobListDto>(API_ENDPOINTS.jobs.list, params),
  detail: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.jobs.detail(id) : get<GenerationJobDto>(API_ENDPOINTS.jobs.detail(id)),
  cancel: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.jobs.cancel(id) : post<GenerationJobDto>(API_ENDPOINTS.jobs.cancel(id)),
  retry: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.jobs.retry(id) : post<GenerationJobDto>(API_ENDPOINTS.jobs.retry(id)),
  remove: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.jobs.remove(id) : del<{ deleted: boolean }>(API_ENDPOINTS.jobs.detail(id)),
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

export const libraryApi = {
  detail: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.library.detail(id) : get<AssetDto>(API_ENDPOINTS.library.detail(id)),
  list: (params?: { limit?: number; cursor?: string; q?: string; kind?: 'image' | 'video'; eligible?: boolean }) =>
    WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.library.list(params) : get<AssetListDto>(API_ENDPOINTS.library.list, params),
  download: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.library.download(id) : get<AssetDownloadDto>(API_ENDPOINTS.library.download(id)),
  remove: (id: string) => WORKSPACE_MODE === 'mock' ? mockWorkspaceApi.library.remove(id) : del<{ deleted: boolean }>(API_ENDPOINTS.library.detail(id)),
}

// ---------------------------------------------------------------------------
// 参考图直传（generation-uploads）+ 媒体直传（media）
// ---------------------------------------------------------------------------

export type UploadProgressHandler = (percent: number) => void

/**
 * 按预签名描述把文件 POST 到对象存储。
 *
 * S3 POST 策略与本地存储签名上传口（`/api/media/upload?...`）都是 multipart：
 * `fields` 必须先写、`file` 必须最后写。响应体为 204，故不走 JSON 信封。
 */
function uploadToPresigned(
  target: { uploadUrl: string; fields: Record<string, string> },
  file: File | Blob,
  options: { onProgress?: UploadProgressHandler; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const [key, value] of Object.entries(target.fields)) form.append(key, value)
    form.append('file', file, 'file')

    const xhr = new XMLHttpRequest()
    xhr.open('POST', target.uploadUrl.startsWith('http') ? target.uploadUrl : resolveApiUrl(target.uploadUrl))
    xhr.withCredentials = true
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return
      options.onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new ApiError(xhr.status, `HTTP_${xhr.status}`, `上传至存储服务失败（HTTP ${xhr.status}）`))
    }
    xhr.onerror = () =>
      reject(
        new ApiError(
          0,
          'UPLOAD_NETWORK_ERROR',
          '无法读取存储服务响应，请检查跨域允许来源（MINIO_API_CORS_ALLOW_ORIGIN）或网络连接',
        ),
      )
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', '上传已取消'))
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

export const generationUploadsApi = {
  create: (body: { mimeType: string; sizeBytes: number }) =>
    post<PresignedUploadDto>(API_ENDPOINTS.generationUploads.create, body),
  complete: (uploadId: string) =>
    post<UploadCompleteDto>(API_ENDPOINTS.generationUploads.complete(uploadId)),
  remove: (uploadId: string) => del<{ deleted: boolean }>(API_ENDPOINTS.generationUploads.remove(uploadId)),
}

export const mediaApi = {
  /** 受签名保护的媒体对象读取端点（URL 由服务端签发，客户端不自行拼参数）。 */
  objectPath: API_ENDPOINTS.media.object,
  uploadPath: API_ENDPOINTS.media.upload,
  upload: uploadToPresigned,
}

// ---------------------------------------------------------------------------
// setup 向导（含管理员/数据库/模板导入）
// ---------------------------------------------------------------------------

export interface SetupAdminVerifyInput {
  email: string
  code: string
}

export const setupApi = {
  getStatus: () => get<SetupStatusResponse>(API_ENDPOINTS.setup.status),
  getConfig: () => get<SetupConfigDto>(API_ENDPOINTS.setup.config),
  complete: () => post<SetupCompletionPayload>(API_ENDPOINTS.setup.complete),
  claim: (input: SetupClaimInput) => post<SetupClaimResult>(API_ENDPOINTS.setup.claim, input),
  updateSite: (input: SiteSettingsInput) => post<SiteSettingsDto>(API_ENDPOINTS.setup.site, input),
  updateSmtp: (input: SmtpSettingsInput) => post<SmtpSettingsDto>(API_ENDPOINTS.setup.smtp, input),
  testSmtp: (input: SmtpSettingsInput) =>
    post<SetupSmtpTestResult>(API_ENDPOINTS.setup.smtpTest, input),
  updateStorage: (input: StorageSettingsInput) =>
    post<StorageSettingsDto>(API_ENDPOINTS.setup.storage, input),
  testStorage: (input: StorageSettingsInput) =>
    post<SetupStorageTestResult>(API_ENDPOINTS.setup.storageTest, input),
  getDatabase: () => get<SetupDatabaseStatus>(API_ENDPOINTS.setup.database),
  testDatabase: () => post<SetupDatabaseTestResult>(API_ENDPOINTS.setup.databaseTest),
  updateRuntime: (input: RuntimeSettingsInput) =>
    post<RuntimeSettingsDto>(API_ENDPOINTS.setup.runtime, input),
  importPromptTemplates: (entries: Array<{ name: string; description?: string; instruction: string }>) =>
    post<SetupTemplateImportResult>(API_ENDPOINTS.setup.promptTemplatesImport, { templates: entries }),
  requestAdmin: (email: string) =>
    post<SetupAdminRequestResult>(API_ENDPOINTS.setup.adminRequest, { email }),
  verifyAdmin: (input: SetupAdminVerifyInput) =>
    post<SessionDto>(API_ENDPOINTS.setup.adminVerify, input),
}

// ---------------------------------------------------------------------------
// 管理后台
// ---------------------------------------------------------------------------

export interface AdminListParams {
  limit?: number
  cursor?: string
  [key: string]: string | number | boolean | undefined
}

export interface AdminUsersFilters extends AdminListParams {
  status?: 'active' | 'disabled'
  email?: string
}

export interface AdminJobsFilters extends AdminListParams {
  userId?: string
  status?: string
  modelId?: string
  from?: string
  to?: string
}

/** 插件图标 / 原始包 / 文档下载是同源 GET，URL 可直接用于 `<img src>` / `<a href>`。 */
function pluginMultipart(path: string, field: 'package' | 'file', file: File, signal?: AbortSignal) {
  const form = new FormData()
  form.append(field, file, file.name)
  return apiFetch<unknown>(path, { method: 'POST', body: form, signal })
}

/** 本地演示的插件图标与模板导出：直接返回 data URL，不触发任何网络请求。 */
const MOCK_PLUGIN_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#E8F0E6"/><path d="M14 44V20h7l11 14 11-14h7v24h-6V30l-9 11h-6l-9-11v14z" fill="#2F5D3A"/></svg>')}`
const MOCK_PROMPT_EXPORT = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ name: '演示提示词集', version: 3, templates: [{ name: '写实摄影', instruction: '将用户描述扩展为写实摄影提示词。' }] }, null, 2))}`

export const adminApi = {
  getDashboard: () => get<AdminDashboardDto>(API_ENDPOINTS.admin.dashboard),

  getRegistration: () => get<RegistrationModeDto>(API_ENDPOINTS.admin.registration),
  setRegistration: (requiresInvitation: boolean) =>
    patch<RegistrationModeDto>(API_ENDPOINTS.admin.registration, { requiresInvitation }),

  // --- 用户 -------------------------------------------------------------
  listUsers: (params?: AdminUsersFilters) =>
    get<{ items: AdminUserDto[]; total: number; hasMore: boolean; nextCursor?: string }>(
      API_ENDPOINTS.admin.users,
      params,
    ),
  setUserStatus: (id: string, status: 'active' | 'disabled') =>
    patch<AdminUserDto>(API_ENDPOINTS.admin.userStatus(id), { status }),
  deleteUser: (id: string) => del<{ deleted: boolean }>(API_ENDPOINTS.admin.user(id)),

  // --- 任务 -------------------------------------------------------------
  listJobs: (params?: AdminJobsFilters) =>
    get<{ items: AdminJobDto[]; total: number; hasMore: boolean; nextCursor?: string }>(
      API_ENDPOINTS.admin.jobs,
      params,
    ),

  // --- 邀请码 -----------------------------------------------------------
  listInvitations: () =>
    get<{ items: InvitationDto[]; total: number; hasMore: boolean }>(API_ENDPOINTS.admin.invitations),
  createInvitation: () => post<InvitationDto>(API_ENDPOINTS.admin.invitations),
  revokeInvitation: (id: string) => del<{ revoked: boolean }>(API_ENDPOINTS.admin.invitation(id)),

  // --- 模型 -------------------------------------------------------------
  listModels: () => get<AdminModelDto[]>(API_ENDPOINTS.admin.models),
  createModel: (input: AdminModelInput) => post<AdminModelDto>(API_ENDPOINTS.admin.models, input),
  updateModel: (id: string, input: AdminModelInput) =>
    patch<AdminModelDto>(API_ENDPOINTS.admin.model(id), input),
  deleteModel: (id: string) => del<{ deleted: boolean }>(API_ENDPOINTS.admin.model(id)),
  listModelPresets: () => get<ModelPresetDto[]>(API_ENDPOINTS.admin.modelPresets),

  // --- 供应商凭据 / 模板 / 插件 -----------------------------------------
  listProviderCredentials: () => get<ProviderCredentialDto[]>(API_ENDPOINTS.admin.providerCredentials),
  createProviderCredential: (input: ProviderCredentialInput) =>
    post<ProviderCredentialDto>(API_ENDPOINTS.admin.providerCredentials, input),
  updateProviderCredential: (id: string, input: ProviderCredentialInput) =>
    patch<ProviderCredentialDto>(API_ENDPOINTS.admin.providerCredential(id), input),
  deleteProviderCredential: (id: string) =>
    del<{ deleted: boolean }>(API_ENDPOINTS.admin.providerCredential(id)),
  testProviderCredential: (id: string) =>
    post<{ tested: boolean; status: 'success' | 'pending' }>(
      API_ENDPOINTS.admin.providerCredentialTest(id),
    ),
  listProviderTemplates: async (): Promise<BuiltinProviderTemplate[]> => {
    const result = await get<{ templates: BuiltinProviderTemplate[] }>(API_ENDPOINTS.admin.providerTemplates)
    return result.templates
  },

  listPlugins: () => get<AdminPluginDto[]>(API_ENDPOINTS.admin.plugins),
  validatePluginPackage: (file: File, signal?: AbortSignal) =>
    pluginMultipart(API_ENDPOINTS.admin.pluginValidate, 'package', file, signal) as Promise<AdminPluginValidateResult>,
  uploadPluginPackage: (file: File, signal?: AbortSignal) =>
    pluginMultipart(API_ENDPOINTS.admin.pluginUpload, 'package', file, signal) as Promise<AdminPluginUploadResult>,
  setPluginStatus: (id: string, status: 'active' | 'disabled') =>
    patch<AdminPluginDto>(API_ENDPOINTS.admin.plugin(id), { status }),
  deletePlugin: (id: string) =>
    del<AdminPluginDeleteResult>(API_ENDPOINTS.admin.plugin(id)),
  getPluginDocs: (id: string) => get<AdminPluginDocsDto>(API_ENDPOINTS.admin.pluginDocs(id)),
  pluginIconUrl: (id: string) => WORKSPACE_MODE === 'mock' ? MOCK_PLUGIN_ICON : resolveApiUrl(API_ENDPOINTS.admin.pluginIcon(id)),
  pluginPackageUrl: (id: string) => WORKSPACE_MODE === 'mock' ? '#' : resolveApiUrl(API_ENDPOINTS.admin.pluginPackage(id)),

  // --- OAuth ------------------------------------------------------------
  listOAuthProviders: () => get<AdminOAuthProviderDto[]>(API_ENDPOINTS.admin.oauthProviders),
  updateOAuthProvider: (provider: OAuthProvider, input: OAuthProviderInput) =>
    patch<AdminOAuthProviderDto>(API_ENDPOINTS.admin.oauthProvider(provider), input),

  // --- 提示词模板 -------------------------------------------------------
  getActivePromptTemplates: () =>
    get<PromptTemplateSetDetailDto | null>(API_ENDPOINTS.admin.promptTemplates),
  listPromptTemplateSets: () =>
    get<PromptTemplateSetSummaryDto[]>(API_ENDPOINTS.admin.promptTemplateSets),
  getPromptTemplateSet: (id: string) =>
    get<PromptTemplateSetDetailDto>(API_ENDPOINTS.admin.promptTemplateSet(id)),
  activatePromptTemplateSet: (id: string) =>
    post<PromptTemplateSetSummaryDto>(API_ENDPOINTS.admin.promptTemplateSetActivate(id)),
  createPromptTemplateEntry: (setId: string, input: CreatePromptTemplateEntryInput) =>
    post<PromptTemplateSetDetailDto>(API_ENDPOINTS.admin.promptTemplateSetEntries(setId), input),
  updatePromptTemplateEntry: (entryId: string, input: UpdatePromptTemplateEntryInput) =>
    patch<PromptTemplateSetDetailDto>(API_ENDPOINTS.admin.promptTemplateEntry(entryId), input),
  deletePromptTemplateEntry: (entryId: string) =>
    del<{ deleted: true; setId: string }>(API_ENDPOINTS.admin.promptTemplateEntry(entryId)),
  deletePromptTemplateSet: (id: string) =>
    del<{ deleted: true }>(API_ENDPOINTS.admin.promptTemplateSet(id)),
  importPromptTemplates: (input: ImportPromptTemplateSetInput) =>
    post<ImportPromptTemplateSetResult>(API_ENDPOINTS.admin.promptTemplatesImport, input),
  previewPromptTemplate: (input: RenderPromptTemplateInput) =>
    post<RenderPromptTemplateResult>(API_ENDPOINTS.admin.promptTemplatesPreview, input),
  /** 导出为原始 JSON 文本（服务端返回 attachment；导出按钮应直接下载）。 */
  promptTemplatesExportUrl: (setId?: string) =>
    WORKSPACE_MODE === 'mock' ? MOCK_PROMPT_EXPORT : resolveApiUrl(API_ENDPOINTS.admin.promptTemplatesExport, setId ? { setId } : undefined),

  // --- 设置 -------------------------------------------------------------
  getPromptOptimizationSettings: () =>
    get<PromptOptimizationSettingsDto>(API_ENDPOINTS.admin.promptOptimizationSettings),
  updatePromptOptimizationSettings: (input: PromptOptimizationSettingsInput) =>
    patch<PromptOptimizationSettingsDto>(API_ENDPOINTS.admin.promptOptimizationSettings, input),
  getMediaModelDefaults: () => get<MediaModelDefaultsDto>(API_ENDPOINTS.admin.mediaModelDefaults),
  updateMediaModelDefaults: (input: UpdateMediaModelDefaultsRequest) =>
    patch<MediaModelDefaultsDto>(API_ENDPOINTS.admin.mediaModelDefaults, input),
}

/** 领域聚合，便于 `import { clientApi } from '@/shared/services/client-api'`。 */
export const clientApi = {
  agent: agentApi,
  session: sessionApi,
  auth: authApi,
  account: accountApi,
  models: modelsApi,
  jobs: jobsApi,
  library: libraryApi,
  generationUploads: generationUploadsApi,
  media: mediaApi,
  setup: setupApi,
  admin: adminApi,
} as const
