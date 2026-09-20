'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { UserProfile, LoginCredentials } from '@/shared/types'
import { useEffect } from 'react'

export const AUTH_USER_QUERY_KEY = ['auth', 'me'] as const

export function useCurrentUserQuery() {
  const setUser = useAuthUiStore((s) => s.setUser)
  const setIsLoading = useAuthUiStore((s) => s.setIsLoading)

  const query = useQuery({
    queryKey: AUTH_USER_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getMe()
      if (!res.success || !res.data) {
        return null
      }
      return res.data as UserProfile
    },
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  useEffect(() => {
    if (query.status === 'success') {
      setUser(query.data)
    } else if (query.status === 'error') {
      setUser(null)
    }
    setIsLoading(query.isLoading)
  }, [query.status, query.data, query.isLoading, setUser, setIsLoading])

  return query
}

export function useLoginMutation() {
  const queryClient = useQueryClient()
  const setUser = useAuthUiStore((s) => s.setUser)

  return useMutation({
    mutationFn: async (credentials: LoginCredentials) => {
      const res = await api.login(credentials)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '登录失败')
      }
      return res.data as UserProfile
    },
    onSuccess: (user) => {
      setUser(user)
      queryClient.setQueryData(AUTH_USER_QUERY_KEY, user)
      queryClient.invalidateQueries()
    },
  })
}

export function useLogoutMutation() {
  const queryClient = useQueryClient()
  const clearAuth = useAuthUiStore((s) => s.clearAuth)

  return useMutation({
    mutationFn: async () => {
      await api.logout()
    },
    onSuccess: () => {
      clearAuth()
      queryClient.clear()
    },
  })
}

export const useLogout = useLogoutMutation
export const useLogin = useLoginMutation

