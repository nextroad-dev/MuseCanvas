'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { CreditBalance, BillingSettings, UserProfile } from '@/shared/types'

export const ACCOUNT_QUERY_KEY = ['account'] as const
export const CREDITS_QUERY_KEY = ['account', 'credits'] as const
export const BILLING_SETTINGS_QUERY_KEY = ['account', 'billing-settings'] as const

export function useAccountQuery() {
  return useQuery({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getMe()
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取用户账户失败')
      }
      return res.data as UserProfile
    },
  })
}

export function useCreditsQuery() {
  return useQuery({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getCredits()
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取积分余额失败')
      }
      return res.data as CreditBalance
    },
  })
}

export const useAccountCredits = useCreditsQuery


export function useBillingSettingsQuery() {
  return useQuery({
    queryKey: BILLING_SETTINGS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getBillingSettings()
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取计费配置失败')
      }
      return res.data as BillingSettings
    },
    staleTime: 5 * 60 * 1000,
  })
}
