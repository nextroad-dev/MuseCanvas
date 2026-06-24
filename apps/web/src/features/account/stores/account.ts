import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OAuthIdentity } from '@/shared/types'
import { api } from '@/shared/services/api'

export const useAccountStore = defineStore('account', () => {
  const oauthIdentities = ref<OAuthIdentity[]>([])

  async function fetchOAuthIdentities() {
    const res = await api<OAuthIdentity[]>('/api/account/oauth')
    if (res.success && res.data) oauthIdentities.value = res.data
    return res
  }

  // Link starts a full-page OAuth round-trip; the callback redirects back to
  // /account?linked=1 (or ?error=CODE), so no in-place state update is needed.
  function linkOAuth(provider: 'github' | 'google') {
    window.location.href = `/api/account/oauth/${provider}/link/start`
  }

  async function unlinkOAuth(provider: 'github' | 'google') {
    const res = await api(`/api/account/oauth/${provider}`, { method: 'DELETE' })
    if (res.success) oauthIdentities.value = oauthIdentities.value.filter((i) => i.provider !== provider)
    return res
  }

  return { oauthIdentities, fetchOAuthIdentities, linkOAuth, unlinkOAuth }
})
