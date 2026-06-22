import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User, OAuthProviderInfo } from '@/types'
import { api } from '@/services/api'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const initialized = ref(false)
  const oauthProviders = ref<OAuthProviderInfo[]>([])

  const isLoggedIn = computed(() => !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function init() {
    if (initialized.value) return
    const res = await api<{ user: User }>('/api/session')
    if (res.success && res.data) {
      user.value = res.data.user
    }
    initialized.value = true
  }

  async function requestOtp(email: string, invitationCode?: string) {
    return api<{ accepted: boolean; nextStep: 'invitation' | 'otp' }>('/api/auth/otp/request', {
      method: 'POST',
      body: { email, invitationCode },
    })
  }

  async function verifyOtp(email: string, code: string, invitationCode?: string) {
    const res = await api<{ user: User }>('/api/auth/otp/verify', {
      method: 'POST',
      body: { email, code, invitationCode },
    })
    if (res.success && res.data) {
      user.value = res.data.user
    }
    return res
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    user.value = null
  }

  async function fetchOAuthProviders() {
    const res = await api<{ providers: OAuthProviderInfo[] }>('/api/auth/oauth/providers')
    if (res.success && res.data) oauthProviders.value = res.data.providers
    return res
  }

  // Full-page navigation so the provider can set/clear its own cookies and
  // redirect back to /login or /generate with a freshly-issued session.
  function startOAuth(provider: 'github' | 'google') {
    window.location.href = `/api/auth/oauth/${provider}/start`
  }

  async function completeOAuthInvitation(challengeId: string, invitationCode: string) {
    const res = await api<{ user: User }>('/api/auth/oauth/invitation', {
      method: 'POST',
      body: { challengeId, invitationCode },
    })
    if (res.success && res.data) user.value = res.data.user
    return res
  }

  return {
    user, initialized, isLoggedIn, isAdmin, oauthProviders,
    init, requestOtp, verifyOtp, logout,
    fetchOAuthProviders, startOAuth, completeOAuthInvitation,
  }
})
