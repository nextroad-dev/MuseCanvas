import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AdminUser, AdminModel, AdminJob, DashboardMetrics, JobStatus,
  Invitation, ModelPreset, BuiltinProviderTemplate,
  ProviderCredential, ProviderCredentialInput,
  AdminOAuthProvider, OAuthProviderInput,
  PromptTemplateSetSummaryDto, PromptTemplateSetDetailDto,
  ImportPromptTemplateSetInput, ImportPromptTemplateSetResult,
  CreatePromptTemplateEntryInput, UpdatePromptTemplateEntryInput,
  DeletePromptTemplateEntryResult,
  RenderPromptTemplateInput, RenderPromptTemplateResult,
  PromptOptimizationSettings,
  BillingSettings, UpdateBillingSettingsInput, AdjustCreditsInput, CreditBalance,
} from '@/shared/types'
import { api } from '@/shared/services/api'
import {
  buildPromptTemplateExportFilename,
  buildPromptTemplateExportUrl,
} from '@/features/admin/lib/prompt-templates'

export const useAdminStore = defineStore('admin', () => {
  // Dashboard
  const metrics = ref<DashboardMetrics | null>(null)

  // Users
  const users = ref<AdminUser[]>([])
  const usersTotal = ref(0)
  const usersNextCursor = ref<string | null>(null)

  // Models
  const models = ref<AdminModel[]>([])
  const modelPresets = ref<ModelPreset[]>([])

  // Jobs
  const jobs = ref<AdminJob[]>([])
  const jobsTotal = ref(0)
  const jobsNextCursor = ref<string | null>(null)

  // Registration
  const requiresInvitation = ref(false)
  const invitations = ref<Invitation[]>([])

  // Provider credentials
  const providerCredentials = ref<ProviderCredential[]>([])
  const providerTemplates = ref<BuiltinProviderTemplate[]>([])

  // OAuth providers
  const oauthProviders = ref<AdminOAuthProvider[]>([])
  const activePromptTemplateSet = ref<PromptTemplateSetDetailDto | null>(null)
  const promptTemplateSets = ref<PromptTemplateSetSummaryDto[]>([])
  const selectedPromptTemplateSet = ref<PromptTemplateSetDetailDto | null>(null)
  const promptOptimizationSettings = ref<PromptOptimizationSettings | null>(null)
  const billingSettings = ref<BillingSettings | null>(null)

  async function fetchDashboard() {
    const res = await api<DashboardMetrics>('/api/admin/dashboard')
    if (res.success && res.data) metrics.value = res.data
  }

  async function fetchUsers(loadMore = false) {
    const params = loadMore && usersNextCursor.value ? { cursor: usersNextCursor.value } : undefined
    const res = await api<{ items: AdminUser[]; total: number; nextCursor?: string }>('/api/admin/users', { params })
    if (res.success && res.data) {
      users.value = loadMore ? [...users.value, ...res.data.items] : res.data.items
      usersTotal.value = res.data.total
      usersNextCursor.value = res.data.nextCursor || null
    }
  }

  async function updateUserStatus(id: string, status: string) {
    const res = await api<AdminUser>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: { status },
    })
    if (res.success && res.data) {
      const idx = users.value.findIndex((u) => u.id === id)
      if (idx >= 0) users.value[idx] = res.data
    }
    return res
  }

  async function deleteUser(id: string) {
    const res = await api(`/api/admin/users/${id}`, { method: 'DELETE' })
    if (res.success) {
      users.value = users.value.filter((u) => u.id !== id)
    }
    return res
  }

  async function fetchModels() {
    const res = await api<AdminModel[]>('/api/admin/models')
    if (res.success && res.data) models.value = res.data
  }

  async function fetchModelPresets() {
    const res = await api<ModelPreset[]>('/api/admin/model-presets')
    if (res.success && res.data) modelPresets.value = res.data
  }

  async function createModel(data: Partial<AdminModel>) {
    const res = await api<AdminModel>('/api/admin/models', { method: 'POST', body: data })
    if (res.success && res.data) models.value.push(res.data)
    return res
  }

  async function updateModel(id: string, data: Partial<AdminModel>) {
    const res = await api<AdminModel>(`/api/admin/models/${id}`, { method: 'PATCH', body: data })
    if (res.success && res.data) {
      const idx = models.value.findIndex((m) => m.id === id)
      if (idx >= 0) models.value[idx] = res.data
    }
    return res
  }

  async function deleteModel(id: string) {
    const res = await api(`/api/admin/models/${id}`, { method: 'DELETE' })
    if (res.success) {
      models.value = models.value.filter((m) => m.id !== id)
      if (promptOptimizationSettings.value?.languageModelConfigId === id) {
        promptOptimizationSettings.value = {
          ...promptOptimizationSettings.value,
          enabled: false,
          languageModelConfigId: null,
        }
      }
    }
    return res
  }

  async function fetchJobs(filters: { userId?: string; status?: JobStatus | ''; modelId?: string; from?: string; to?: string } = {}, loadMore = false) {
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(filters)) if (value) params[key] = value
    if (loadMore && jobsNextCursor.value) params.cursor = jobsNextCursor.value
    const res = await api<{ items: AdminJob[]; total: number; nextCursor?: string }>('/api/admin/jobs', { params })
    if (res.success && res.data) {
      jobs.value = loadMore ? [...jobs.value, ...res.data.items] : res.data.items
      jobsTotal.value = res.data.total
      jobsNextCursor.value = res.data.nextCursor || null
    }
  }

  async function fetchRegistration() {
    const res = await api<{ requiresInvitation: boolean }>('/api/admin/registration')
    if (res.success && res.data) requiresInvitation.value = res.data.requiresInvitation
  }

  async function setRequiresInvitation(value: boolean) {
    const previous = requiresInvitation.value
    requiresInvitation.value = value
    const res = await api<{ requiresInvitation: boolean }>('/api/admin/registration', {
      method: 'PATCH',
      body: { requiresInvitation: value },
    })
    if (res.success && res.data) requiresInvitation.value = res.data.requiresInvitation
    else requiresInvitation.value = previous
    return res
  }

  async function fetchInvitations() {
    const res = await api<{ items: Invitation[] }>('/api/admin/invitations')
    if (res.success && res.data) invitations.value = res.data.items
  }

  async function createInvitation() {
    const res = await api<Invitation>('/api/admin/invitations', {
      method: 'POST',
      body: {},
    })
    if (res.success && res.data) invitations.value.unshift(res.data)
    return res
  }

  async function revokeInvitation(id: string) {
    const res = await api(`/api/admin/invitations/${id}`, { method: 'DELETE' })
    if (res.success) {
      invitations.value = invitations.value.filter((i) => i.id !== id)
    }
    return res
  }

  async function fetchProviderCredentials() {
    const res = await api<ProviderCredential[]>('/api/admin/provider-credentials')
    if (res.success && res.data) providerCredentials.value = res.data
    return res
  }

  async function fetchProviderTemplates() {
    const res = await api<{ templates: BuiltinProviderTemplate[] } | BuiltinProviderTemplate[]>('/api/admin/provider-templates')
    if (res.success && res.data) {
      providerTemplates.value = Array.isArray(res.data) ? res.data : res.data.templates || []
    }
    return res
  }

  async function createProviderCredential(data: ProviderCredentialInput) {
    const res = await api<ProviderCredential>('/api/admin/provider-credentials', { method: 'POST', body: data })
    if (res.success && res.data) providerCredentials.value.unshift(res.data)
    return res
  }

  async function updateProviderCredential(id: string, data: ProviderCredentialInput) {
    const res = await api<ProviderCredential>(`/api/admin/provider-credentials/${id}`, { method: 'PATCH', body: data })
    if (res.success && res.data) {
      const idx = providerCredentials.value.findIndex((c) => c.id === id)
      if (idx >= 0) providerCredentials.value[idx] = res.data
    }
    return res
  }

  async function testProviderCredential(id: string) {
    const res = await api<{ tested: boolean; status: string }>(`/api/admin/provider-credentials/${id}/test`, { method: 'POST' })
    // Test mutates last_test_* server-side; refresh to reflect the new status.
    await fetchProviderCredentials()
    return res
  }

  async function deleteProviderCredential(id: string) {
    const res = await api(`/api/admin/provider-credentials/${id}`, { method: 'DELETE' })
    if (res.success) providerCredentials.value = providerCredentials.value.filter((c) => c.id !== id)
    return res
  }

  async function fetchOAuthProviders() {
    const res = await api<AdminOAuthProvider[]>('/api/admin/oauth-providers')
    if (res.success && res.data) oauthProviders.value = res.data
    return res
  }

  async function updateOAuthProvider(provider: 'github' | 'google', data: OAuthProviderInput) {
    const res = await api<AdminOAuthProvider>(`/api/admin/oauth-providers/${provider}`, { method: 'PATCH', body: data })
    if (res.success && res.data) {
      const idx = oauthProviders.value.findIndex((p) => p.provider === provider)
      if (idx >= 0) oauthProviders.value[idx] = res.data
      else oauthProviders.value.push(res.data)
    }
    return res
  }

  async function fetchActivePromptTemplateSet() {
    const res = await api<PromptTemplateSetDetailDto | null>('/api/admin/prompt-templates')
    if (res.success) activePromptTemplateSet.value = res.data ?? null
    return res
  }

  async function fetchPromptTemplateSets() {
    const res = await api<PromptTemplateSetSummaryDto[]>('/api/admin/prompt-templates/sets')
    if (res.success) promptTemplateSets.value = res.data ?? []
    return res
  }

  async function fetchPromptTemplateSetDetail(id: string, select = true) {
    const res = await api<PromptTemplateSetDetailDto>(`/api/admin/prompt-templates/sets/${id}`)
    if (res.success && res.data && select) selectedPromptTemplateSet.value = res.data
    return res
  }

  /** Re-read active set, history, and the selected detail (best-effort) after a mutation. */
  async function refreshPromptTemplateState() {
    await Promise.all([fetchActivePromptTemplateSet(), fetchPromptTemplateSets()])
    const selectedId = selectedPromptTemplateSet.value?.id
    if (selectedId) {
      const res = await fetchPromptTemplateSetDetail(selectedId)
      if (!res.success) selectedPromptTemplateSet.value = null
    }
  }

  async function importPromptTemplateSet(input: ImportPromptTemplateSetInput) {
    const res = await api<ImportPromptTemplateSetResult>('/api/admin/prompt-templates/import', {
      method: 'POST',
      body: input,
    })
    if (res.success) await refreshPromptTemplateState()
    return res
  }

  async function activatePromptTemplateSet(id: string) {
    const res = await api<PromptTemplateSetSummaryDto>(`/api/admin/prompt-templates/sets/${id}/activate`, {
      method: 'POST',
      body: {},
    })
    if (res.success) await refreshPromptTemplateState()
    return res
  }

  async function deletePromptTemplateSet(id: string) {
    const res = await api(`/api/admin/prompt-templates/sets/${id}`, { method: 'DELETE' })
    if (res.success) {
      if (selectedPromptTemplateSet.value?.id === id) selectedPromptTemplateSet.value = null
      await refreshPromptTemplateState()
    }
    return res
  }

  async function createPromptTemplateEntry(setId: string, input: CreatePromptTemplateEntryInput) {
    const res = await api<PromptTemplateSetDetailDto>(`/api/admin/prompt-templates/sets/${setId}/entries`, {
      method: 'POST',
      body: input,
    })
    if (res.success && res.data) {
      // Entry mutations fork a new version: adopt the forked set, then refresh.
      selectedPromptTemplateSet.value = res.data
      await Promise.all([fetchActivePromptTemplateSet(), fetchPromptTemplateSets()])
    }
    return res
  }

  async function updatePromptTemplateEntry(entryId: string, input: UpdatePromptTemplateEntryInput) {
    const res = await api<PromptTemplateSetDetailDto>(`/api/admin/prompt-templates/entries/${entryId}`, {
      method: 'PATCH',
      body: input,
    })
    if (res.success && res.data) {
      // Entry mutations fork a new version: adopt the forked set, then refresh.
      selectedPromptTemplateSet.value = res.data
      await Promise.all([fetchActivePromptTemplateSet(), fetchPromptTemplateSets()])
    }
    return res
  }

  async function deletePromptTemplateEntry(entryId: string) {
    const res = await api<DeletePromptTemplateEntryResult>(`/api/admin/prompt-templates/entries/${entryId}`, { method: 'DELETE' })
    if (res.success && res.data) {
      // Deletion forks a new version: adopt the forked set, then refresh.
      await Promise.all([fetchActivePromptTemplateSet(), fetchPromptTemplateSets(), fetchPromptTemplateSetDetail(res.data.setId)])
    }
    return res
  }

  async function previewPromptTemplate(input: RenderPromptTemplateInput) {
    return api<RenderPromptTemplateResult>('/api/admin/prompt-templates/preview', {
      method: 'POST',
      body: input,
    })
  }

  /**
   * Download the standard JSON for a set (active set when omitted) via a
   * browser anchor download. Blob download needs the raw response, so this
   * action uses `fetch` directly instead of the JSON `api` helper.
   */
  async function exportPromptTemplateSet(setId?: string | null) {
    const path = buildPromptTemplateExportUrl(setId ?? undefined)
    const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
    const url = base.endsWith('/api') && path.startsWith('/api/')
      ? base + path.slice(4)
      : base + path
    try {
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) {
        let message = '导出失败'
        try {
          const body = (await res.json()) as { error?: { message?: string } }
          if (body?.error?.message) message = body.error.message
        } catch {
          // Keep the default message when the error body is not JSON.
        }
        return { success: false as const, error: { code: `HTTP_${res.status}`, message } }
      }
      const blob = await res.blob()
      const meta = promptTemplateSets.value.find((s) => s.id === setId)
        ?? (activePromptTemplateSet.value && (!setId || activePromptTemplateSet.value.id === setId)
          ? activePromptTemplateSet.value
          : null)
      const filename = buildPromptTemplateExportFilename(meta, setId)
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      return { success: true as const, data: { filename } }
    } catch {
      return { success: false as const, error: { code: 'NETWORK_ERROR', message: '网络连接失败' } }
    }
  }

  async function fetchPromptOptimizationSettings() {
    const res = await api<PromptOptimizationSettings>('/api/admin/prompt-optimization-settings')
    if (res.success && res.data) promptOptimizationSettings.value = res.data
    return res
  }

  async function updatePromptOptimizationSettings(data: Partial<PromptOptimizationSettings>) {
    const res = await api<PromptOptimizationSettings>('/api/admin/prompt-optimization-settings', { method: 'PATCH', body: data })
    if (res.success && res.data) promptOptimizationSettings.value = res.data
    return res
  }

  async function fetchBillingSettings() {
    const res = await api<BillingSettings>('/api/admin/billing-settings')
    if (res.success && res.data) billingSettings.value = res.data
    return res
  }

  async function updateBillingSettings(data: UpdateBillingSettingsInput) {
    const res = await api<BillingSettings>('/api/admin/billing-settings', {
      method: 'PATCH',
      body: data,
    })
    if (res.success && res.data) billingSettings.value = res.data
    return res
  }

  async function adjustUserCredits(id: string, data: AdjustCreditsInput) {
    const res = await api<CreditBalance>(`/api/admin/users/${id}/adjust-credits`, {
      method: 'POST',
      body: data,
    })
    if (res.success && res.data) {
      const u = users.value.find((item) => item.id === id)
      if (u) {
        u.credits = res.data
      }
    }
    return res
  }

  return {
    metrics, users, usersTotal, usersNextCursor, models, modelPresets, jobs, jobsTotal, jobsNextCursor,
    requiresInvitation, invitations, providerCredentials, providerTemplates, oauthProviders,
    activePromptTemplateSet, promptTemplateSets, selectedPromptTemplateSet,
    promptOptimizationSettings, billingSettings,
    fetchDashboard, fetchUsers, updateUserStatus, deleteUser, adjustUserCredits,
    fetchModels, fetchModelPresets, createModel, updateModel, deleteModel, fetchJobs,
    fetchRegistration, setRequiresInvitation,
    fetchInvitations, createInvitation, revokeInvitation,
    fetchProviderCredentials, fetchProviderTemplates, createProviderCredential, updateProviderCredential, testProviderCredential, deleteProviderCredential,
    fetchOAuthProviders, updateOAuthProvider,
    fetchActivePromptTemplateSet, fetchPromptTemplateSets, fetchPromptTemplateSetDetail,
    importPromptTemplateSet, activatePromptTemplateSet, deletePromptTemplateSet,
    createPromptTemplateEntry, updatePromptTemplateEntry, deletePromptTemplateEntry,
    previewPromptTemplate, exportPromptTemplateSet,
    fetchPromptOptimizationSettings, updatePromptOptimizationSettings,
    fetchBillingSettings, updateBillingSettings,
  }
})
