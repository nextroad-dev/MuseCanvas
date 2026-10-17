'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { ModelConfig } from '@/shared/types'

export const MODELS_QUERY_KEY = ['models'] as const

export function useModelsQuery() {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getModels()
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取模型列表失败')
      }
      return res.data as ModelConfig[]
    },
    staleTime: 5 * 60 * 1000,
  })
}
