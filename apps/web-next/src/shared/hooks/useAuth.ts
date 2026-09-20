'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'

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
