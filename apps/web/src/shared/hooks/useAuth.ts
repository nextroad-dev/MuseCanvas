'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'

export function useLogoutMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      await api.logout()
    },
    onSuccess: () => {
      // The session lives in the query cache (`useAccountQuery`), so clearing
      // every query drops the signed-in user along with the actor-scoped data.
      queryClient.clear()
    },
  })
}

export const useLogout = useLogoutMutation
