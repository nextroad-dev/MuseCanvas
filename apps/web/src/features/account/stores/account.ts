import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OAuthIdentity, CreditBalance, CreditLedgerEntry, BillingSettings, PaginatedResponse } from '@/shared/types'
import { api } from '@/shared/services/api'

export const useAccountStore = defineStore('account', () => {
  const oauthIdentities = ref<OAuthIdentity[]>([])
  const creditBalance = ref<CreditBalance | null>(null)
  const creditsLoading = ref(false)
  const creditsLoaded = ref(false)
  const creditsError = ref<string | null>(null)

  const billingSettings = ref<BillingSettings | null>(null)
  const billingSettingsLoading = ref(false)
  const billingSettingsLoaded = ref(false)
  const billingSettingsError = ref<string | null>(null)

  const creditLedger = ref<CreditLedgerEntry[]>([])
  const ledgerTotal = ref(0)
  const ledgerHasMore = ref(false)
  const ledgerNextCursor = ref<string | undefined>(undefined)
  const ledgerLoading = ref(false)
  const ledgerLoaded = ref(false)
  const ledgerError = ref<string | null>(null)

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

  async function fetchCredits() {
    creditsLoading.value = true
    creditsError.value = null
    const res = await api<CreditBalance>('/api/account/credits')
    creditsLoading.value = false
    if (res.success && res.data) {
      creditBalance.value = res.data
      creditsLoaded.value = true
      creditsError.value = null
    } else {
      creditsError.value = res.error?.message || '获取积分余额失败'
    }
    return res
  }

  async function fetchBillingSettings() {
    billingSettingsLoading.value = true
    billingSettingsError.value = null
    const res = await api<BillingSettings>('/api/billing/settings')
    billingSettingsLoading.value = false
    if (res.success && res.data) {
      billingSettings.value = res.data
      billingSettingsLoaded.value = true
      billingSettingsError.value = null
    } else {
      billingSettingsError.value = res.error?.message || '获取计费设置失败'
    }
    return res
  }

  async function fetchLedger(options?: { reset?: boolean; cursor?: string; limit?: number }) {
    ledgerLoading.value = true
    ledgerError.value = null
    const params: Record<string, string> = {
      limit: String(options?.limit ?? 20),
    }
    if (options?.cursor) {
      params.cursor = options.cursor
    }

    const res = await api<PaginatedResponse<CreditLedgerEntry>>('/api/account/credit-ledger', { params })
    ledgerLoading.value = false

    if (res.success && res.data) {
      if (options?.reset || !options?.cursor) {
        creditLedger.value = res.data.items
      } else {
        creditLedger.value.push(...res.data.items)
      }
      ledgerTotal.value = res.data.total
      ledgerHasMore.value = res.data.hasMore
      ledgerNextCursor.value = res.data.nextCursor
      ledgerLoaded.value = true
      ledgerError.value = null
    } else {
      ledgerError.value = res.error?.message || '获取积分明细失败'
    }
    return res
  }

  return {
    oauthIdentities,
    creditBalance,
    creditsLoading,
    creditsLoaded,
    creditsError,
    billingSettings,
    billingSettingsLoading,
    billingSettingsLoaded,
    billingSettingsError,
    creditLedger,
    ledgerTotal,
    ledgerHasMore,
    ledgerNextCursor,
    ledgerLoading,
    ledgerLoaded,
    ledgerError,
    fetchOAuthIdentities,
    linkOAuth,
    unlinkOAuth,
    fetchCredits,
    fetchBillingSettings,
    fetchLedger,
  }
})
