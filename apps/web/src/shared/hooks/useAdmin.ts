'use client'

// 管理后台 10 个子页共享的 TanStack Query hooks。
// 全部请求经由 `clientApi.admin` / `clientApi.setup`，key 统一来自 `queryKeys.admin` / `queryKeys.setup`，
// 变更操作精确失效关联缓存（模型/插件变更同步刷新前台 `queryKeys.models`）。

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  clientApi,
  type AdminJobsFilters,
  type AdminUsersFilters,
} from '@/shared/services/client-api'
import type {
  AdminDashboardDto,
  AdminJobDto,
  AdminModelDto,
  AdminModelInput,
  AdminOAuthProviderDto,
  AdminPluginDeleteResult,
  AdminPluginDocsDto,
  AdminPluginDto,
  AdminPluginUploadResult,
  AdminPluginValidateResult,
  AdminUserDto,
  BuiltinProviderTemplate,
  CreatePromptTemplateEntryInput,
  DeletePromptTemplateEntryResult,
  DeletePromptTemplateSetResult,
  ImportPromptTemplateSetInput,
  ImportPromptTemplateSetResult,
  InvitationDto,
  MediaModelDefaultsDto,
  ModelPresetDto,
  OAuthProvider,
  OAuthProviderInput,
  PromptOptimizationSettingsDto,
  PromptOptimizationSettingsInput,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
  ProviderCredentialDto,
  ProviderCredentialInput,
  RegistrationModeDto,
  RenderPromptTemplateInput,
  RenderPromptTemplateResult,
  RuntimeSettingsDto,
  RuntimeSettingsInput,
  SetupConfigDto,
  SetupDatabaseStatus,
  SetupDatabaseTestResult,
  SetupSmtpTestResult,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpSettingsDto,
  SmtpSettingsInput,
  UpdateMediaModelDefaultsRequest,
  UpdatePromptTemplateEntryInput,
} from '@/shared/types'
import { queryKeys } from './query-keys'

export type AdminUsersPage = {
  items: AdminUserDto[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export type AdminJobsPage = {
  items: AdminJobDto[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export type AdminInvitationsPage = {
  items: InvitationDto[]
  total: number
  hasMore: boolean
}

const ADMIN_USERS_PREFIX = ['admin', 'users'] as const
const ADMIN_PROMPT_TEMPLATE_SET_PREFIX = ['admin', 'prompt-template-set'] as const

// ---------------------------------------------------------------------------
// 概览与注册模式（/admin）
// ---------------------------------------------------------------------------

export function useAdminDashboard(): UseQueryResult<AdminDashboardDto> {
  return useQuery({
    queryKey: queryKeys.admin.dashboard,
    queryFn: () => clientApi.admin.getDashboard(),
    staleTime: 30_000,
  })
}

export function useAdminRegistration(): UseQueryResult<RegistrationModeDto> {
  return useQuery({
    queryKey: queryKeys.admin.registration,
    queryFn: () => clientApi.admin.getRegistration(),
    staleTime: 30_000,
  })
}

export function useSetAdminRegistration(): UseMutationResult<RegistrationModeDto, Error, boolean> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (requiresInvitation: boolean) => clientApi.admin.setRegistration(requiresInvitation),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.admin.registration, next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.registration })
    },
  })
}

// ---------------------------------------------------------------------------
// 用户管理（/admin/users）
// ---------------------------------------------------------------------------

export function useAdminUsers(filters?: AdminUsersFilters): UseQueryResult<AdminUsersPage> {
  return useQuery({
    queryKey: queryKeys.admin.users(filters),
    queryFn: () => clientApi.admin.listUsers(filters),
    placeholderData: keepPreviousData,
  })
}

export function useSetAdminUserStatus(): UseMutationResult<
  AdminUserDto,
  Error,
  { id: string; status: 'active' | 'disabled' }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }) => clientApi.admin.setUserStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_PREFIX })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.dashboard })
    },
  })
}

export function useDeleteAdminUser(): UseMutationResult<{ deleted: boolean }, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_PREFIX })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.dashboard })
    },
  })
}

// ---------------------------------------------------------------------------
// 邀请码（/admin/invitations）
// ---------------------------------------------------------------------------

export function useAdminInvitations(): UseQueryResult<AdminInvitationsPage> {
  return useQuery({
    queryKey: queryKeys.admin.invitations,
    queryFn: () => clientApi.admin.listInvitations(),
  })
}

export function useCreateAdminInvitation(): UseMutationResult<InvitationDto, Error, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => clientApi.admin.createInvitation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.invitations })
    },
  })
}

export function useRevokeAdminInvitation(): UseMutationResult<{ revoked: boolean }, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.revokeInvitation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.invitations })
    },
  })
}

// ---------------------------------------------------------------------------
// 任务审计（/admin/jobs）
// ---------------------------------------------------------------------------

export function useAdminJobs(filters?: AdminJobsFilters): UseQueryResult<AdminJobsPage> {
  return useQuery({
    queryKey: queryKeys.admin.jobs(filters),
    queryFn: () => clientApi.admin.listJobs(filters),
    placeholderData: keepPreviousData,
  })
}

// ---------------------------------------------------------------------------
// 模型配置与默认媒体模型（/admin/models）
// ---------------------------------------------------------------------------

export function useAdminModels(): UseQueryResult<AdminModelDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.models,
    queryFn: () => clientApi.admin.listModels(),
  })
}

export function useAdminModelPresets(): UseQueryResult<ModelPresetDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.modelPresets,
    queryFn: () => clientApi.admin.listModelPresets(),
    staleTime: 60_000,
  })
}

export function useCreateAdminModel(): UseMutationResult<AdminModelDto, Error, AdminModelInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AdminModelInput) => clientApi.admin.createModel(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.mediaModelDefaults })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptOptimizationSettings })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

export function useUpdateAdminModel(): UseMutationResult<
  AdminModelDto,
  Error,
  { id: string; input: AdminModelInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }) => clientApi.admin.updateModel(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.mediaModelDefaults })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptOptimizationSettings })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

export function useDeleteAdminModel(): UseMutationResult<{ deleted: boolean }, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.deleteModel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.mediaModelDefaults })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptOptimizationSettings })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

export function useAdminMediaModelDefaults(): UseQueryResult<MediaModelDefaultsDto> {
  return useQuery({
    queryKey: queryKeys.admin.mediaModelDefaults,
    queryFn: () => clientApi.admin.getMediaModelDefaults(),
  })
}

export function useUpdateAdminMediaModelDefaults(): UseMutationResult<
  MediaModelDefaultsDto,
  Error,
  UpdateMediaModelDefaultsRequest
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateMediaModelDefaultsRequest) =>
      clientApi.admin.updateMediaModelDefaults(input),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.admin.mediaModelDefaults, next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.mediaModelDefaults })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

// ---------------------------------------------------------------------------
// 供应商凭据与模板（/admin/providers）
// ---------------------------------------------------------------------------

export function useAdminProviderCredentials(): UseQueryResult<ProviderCredentialDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.providerCredentials,
    queryFn: () => clientApi.admin.listProviderCredentials(),
  })
}

export function useAdminProviderTemplates(): UseQueryResult<BuiltinProviderTemplate[]> {
  return useQuery({
    queryKey: queryKeys.admin.providerTemplates,
    queryFn: () => clientApi.admin.listProviderTemplates(),
    staleTime: 60_000,
  })
}

export function useCreateProviderCredential(): UseMutationResult<
  ProviderCredentialDto,
  Error,
  ProviderCredentialInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ProviderCredentialInput) => clientApi.admin.createProviderCredential(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerCredentials })
    },
  })
}

export function useUpdateProviderCredential(): UseMutationResult<
  ProviderCredentialDto,
  Error,
  { id: string; input: ProviderCredentialInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }) => clientApi.admin.updateProviderCredential(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerCredentials })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
    },
  })
}

export function useDeleteProviderCredential(): UseMutationResult<{ deleted: boolean }, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.deleteProviderCredential(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerCredentials })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
    },
  })
}

export function useTestProviderCredential(): UseMutationResult<
  { tested: boolean; status: 'success' | 'pending' },
  Error,
  string
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.testProviderCredential(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerCredentials })
    },
  })
}

// ---------------------------------------------------------------------------
// 插件管理（/admin/plugins）
// ---------------------------------------------------------------------------

export function useAdminPlugins(): UseQueryResult<AdminPluginDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.plugins,
    queryFn: () => clientApi.admin.listPlugins(),
  })
}

export function useAdminPluginDocs(id: string | null | undefined): UseQueryResult<AdminPluginDocsDto> {
  return useQuery({
    queryKey: queryKeys.admin.pluginDocs(id ?? ''),
    queryFn: () => clientApi.admin.getPluginDocs(id as string),
    enabled: Boolean(id),
    staleTime: 60_000,
  })
}

export function useValidateAdminPlugin(): UseMutationResult<
  AdminPluginValidateResult,
  Error,
  { file: File; signal?: AbortSignal }
> {
  return useMutation({
    mutationFn: ({ file, signal }) => clientApi.admin.validatePluginPackage(file, signal),
  })
}

export function useUploadAdminPlugin(): UseMutationResult<
  AdminPluginUploadResult,
  Error,
  { file: File; signal?: AbortSignal }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, signal }) => clientApi.admin.uploadPluginPackage(file, signal),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.plugins })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelPresets })
    },
  })
}

export function useSetAdminPluginStatus(): UseMutationResult<
  AdminPluginDto,
  Error,
  { id: string; status: 'active' | 'disabled' }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }) => clientApi.admin.setPluginStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.plugins })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelPresets })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

export function useDeleteAdminPlugin(): UseMutationResult<AdminPluginDeleteResult, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.deletePlugin(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.admin.pluginDocs(id), exact: true })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.plugins })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.providerTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelPresets })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })
}

// ---------------------------------------------------------------------------
// OAuth 配置（/admin/oauth）
// ---------------------------------------------------------------------------

export function useAdminOAuthProviders(): UseQueryResult<AdminOAuthProviderDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.oauthProviders,
    queryFn: () => clientApi.admin.listOAuthProviders(),
  })
}

export function useUpdateAdminOAuthProvider(): UseMutationResult<
  AdminOAuthProviderDto,
  Error,
  { provider: OAuthProvider; input: OAuthProviderInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, input }) => clientApi.admin.updateOAuthProvider(provider, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.oauthProviders })
    },
  })
}

// ---------------------------------------------------------------------------
// 提示词模板集（/admin/prompt-templates）
// ---------------------------------------------------------------------------

export function useAdminPromptTemplates(): UseQueryResult<PromptTemplateSetDetailDto | null> {
  return useQuery({
    queryKey: queryKeys.admin.promptTemplates,
    queryFn: () => clientApi.admin.getActivePromptTemplates(),
  })
}

export function useAdminPromptTemplateSets(): UseQueryResult<PromptTemplateSetSummaryDto[]> {
  return useQuery({
    queryKey: queryKeys.admin.promptTemplateSets,
    queryFn: () => clientApi.admin.listPromptTemplateSets(),
  })
}

export function useAdminPromptTemplateSet(
  id: string | null | undefined,
): UseQueryResult<PromptTemplateSetDetailDto> {
  return useQuery({
    queryKey: queryKeys.admin.promptTemplateSet(id ?? ''),
    queryFn: () => clientApi.admin.getPromptTemplateSet(id as string),
    enabled: Boolean(id),
  })
}

export function useActivatePromptTemplateSet(): UseMutationResult<
  PromptTemplateSetSummaryDto,
  Error,
  string
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.activatePromptTemplateSet(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSet(id) })
    },
  })
}

export function useCreatePromptTemplateEntry(): UseMutationResult<
  PromptTemplateSetDetailDto,
  Error,
  { setId: string; input: CreatePromptTemplateEntryInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ setId, input }) => clientApi.admin.createPromptTemplateEntry(setId, input),
    onSuccess: (detail, { setId }) => {
      queryClient.setQueryData(queryKeys.admin.promptTemplateSet(setId), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSet(setId) })
    },
  })
}

export function useUpdatePromptTemplateEntry(): UseMutationResult<
  PromptTemplateSetDetailDto,
  Error,
  { entryId: string; input: UpdatePromptTemplateEntryInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ entryId, input }) => clientApi.admin.updatePromptTemplateEntry(entryId, input),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.admin.promptTemplateSet(detail.id), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
      void queryClient.invalidateQueries({ queryKey: ADMIN_PROMPT_TEMPLATE_SET_PREFIX })
    },
  })
}

export function useDeletePromptTemplateEntry(): UseMutationResult<
  DeletePromptTemplateEntryResult,
  Error,
  string
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (entryId: string) => clientApi.admin.deletePromptTemplateEntry(entryId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.promptTemplateSet(result.setId),
      })
    },
  })
}

export function useDeletePromptTemplateSet(): UseMutationResult<
  DeletePromptTemplateSetResult,
  Error,
  string
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clientApi.admin.deletePromptTemplateSet(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.admin.promptTemplateSet(id), exact: true })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
    },
  })
}

export function useImportPromptTemplates(): UseMutationResult<
  ImportPromptTemplateSetResult,
  Error,
  ImportPromptTemplateSetInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ImportPromptTemplateSetInput) => clientApi.admin.importPromptTemplates(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.promptTemplateSet(result.setId),
      })
    },
  })
}

export function usePreviewPromptTemplate(): UseMutationResult<
  RenderPromptTemplateResult,
  Error,
  RenderPromptTemplateInput
> {
  return useMutation({
    mutationFn: (input: RenderPromptTemplateInput) => clientApi.admin.previewPromptTemplate(input),
  })
}

// ---------------------------------------------------------------------------
// 提示词优化与系统设置（/admin/settings）
// ---------------------------------------------------------------------------

export function useAdminPromptOptimizationSettings(): UseQueryResult<PromptOptimizationSettingsDto> {
  return useQuery({
    queryKey: queryKeys.admin.promptOptimizationSettings,
    queryFn: () => clientApi.admin.getPromptOptimizationSettings(),
  })
}

export function useUpdateAdminPromptOptimizationSettings(): UseMutationResult<
  PromptOptimizationSettingsDto,
  Error,
  PromptOptimizationSettingsInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: PromptOptimizationSettingsInput) =>
      clientApi.admin.updatePromptOptimizationSettings(input),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.admin.promptOptimizationSettings, next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptOptimizationSettings })
    },
  })
}

export function useAdminSetupConfig(): UseQueryResult<SetupConfigDto> {
  return useQuery({
    queryKey: queryKeys.setup.config,
    queryFn: () => clientApi.setup.getConfig(),
  })
}

export function useAdminSetupDatabase(): UseQueryResult<SetupDatabaseStatus> {
  return useQuery({
    queryKey: queryKeys.setup.database,
    queryFn: () => clientApi.setup.getDatabase(),
  })
}

export function useUpdateAdminSiteSettings(): UseMutationResult<
  SiteSettingsDto,
  Error,
  SiteSettingsInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SiteSettingsInput) => clientApi.setup.updateSite(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.config })
    },
  })
}

export function useUpdateAdminSmtpSettings(): UseMutationResult<
  SmtpSettingsDto,
  Error,
  SmtpSettingsInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SmtpSettingsInput) => clientApi.setup.updateSmtp(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.config })
    },
  })
}

export function useTestAdminSmtpSettings(): UseMutationResult<
  SetupSmtpTestResult,
  Error,
  SmtpSettingsInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SmtpSettingsInput) => clientApi.setup.testSmtp(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.config })
    },
  })
}

export function useTestAdminDatabase(): UseMutationResult<SetupDatabaseTestResult, Error, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => clientApi.setup.testDatabase(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.database })
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.config })
    },
  })
}

export function useUpdateAdminRuntimeSettings(): UseMutationResult<
  RuntimeSettingsDto,
  Error,
  RuntimeSettingsInput
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: RuntimeSettingsInput) => clientApi.setup.updateRuntime(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.setup.config })
    },
  })
}
