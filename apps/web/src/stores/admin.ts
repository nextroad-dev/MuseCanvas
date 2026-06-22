import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AdminUser, AdminModel, AdminJob, DashboardMetrics, JobStatus,
  SmtpSettings, Invitation, RegistrationMode, ModelPreset,
  ProviderCredential, ProviderCredentialInput,
  AdminOAuthProvider, OAuthProviderInput,
} from '@/types'
import { api } from '@/services/api'

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
  const registrationMode = ref<RegistrationMode>('open')
  const invitations = ref<Invitation[]>([])

  // SMTP
  const smtpSettings = ref<SmtpSettings | null>(null)

  // Provider credentials
  const providerCredentials = ref<ProviderCredential[]>([])

  // OAuth providers
  const oauthProviders = ref<AdminOAuthProvider[]>([])

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
    const res = await api<{ mode: RegistrationMode }>('/api/admin/registration')
    if (res.success && res.data) registrationMode.value = res.data.mode
  }

  async function setRegistrationMode(mode: RegistrationMode) {
    const res = await api<{ mode: RegistrationMode }>('/api/admin/registration', {
      method: 'PATCH',
      body: { mode },
    })
    if (res.success && res.data) registrationMode.value = res.data.mode
    return res
  }

  async function fetchInvitations() {
    const res = await api<{ items: Invitation[] }>('/api/admin/invitations')
    if (res.success && res.data) invitations.value = res.data.items
  }

  async function createInvitation(email: string, count = 1) {
    const res = await api<Invitation[]>('/api/admin/invitations', {
      method: 'POST',
      body: { email, count },
    })
    if (res.success && res.data) invitations.value.unshift(...res.data)
    return res
  }

  async function revokeInvitation(id: string) {
    const res = await api(`/api/admin/invitations/${id}`, { method: 'DELETE' })
    if (res.success) {
      invitations.value = invitations.value.filter((i) => i.id !== id)
    }
    return res
  }

  async function fetchSmtp() {
    const res = await api<SmtpSettings>('/api/admin/smtp')
    if (res.success && res.data) smtpSettings.value = res.data
  }

  async function updateSmtp(data: Partial<SmtpSettings>) {
    const res = await api<SmtpSettings>('/api/admin/smtp', { method: 'PUT', body: data })
    if (res.success && res.data) smtpSettings.value = res.data
    return res
  }

  async function testSmtp() {
    return api('/api/admin/smtp/test', { method: 'POST' })
  }

  async function fetchProviderCredentials() {
    const res = await api<ProviderCredential[]>('/api/admin/provider-credentials')
    if (res.success && res.data) providerCredentials.value = res.data
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

  return {
    metrics, users, usersTotal, usersNextCursor, models, modelPresets, jobs, jobsTotal, jobsNextCursor,
    registrationMode, invitations, smtpSettings, providerCredentials, oauthProviders,
    fetchDashboard, fetchUsers, updateUserStatus, deleteUser,
    fetchModels, fetchModelPresets, createModel, updateModel, fetchJobs,
    fetchRegistration, setRegistrationMode,
    fetchInvitations, createInvitation, revokeInvitation,
    fetchSmtp, updateSmtp, testSmtp,
    fetchProviderCredentials, createProviderCredential, updateProviderCredential, testProviderCredential, deleteProviderCredential,
    fetchOAuthProviders, updateOAuthProvider,
  }
})
