'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { Asset } from '@/shared/types'

export const LIBRARY_QUERY_KEY = ['library'] as const

// Backend GET /api/library ignores kind/favorite/limit/cursor (fixed LIMIT 50).
export interface LibraryQueryParams {
  kind?: string
  favorite?: boolean
  limit?: number
  cursor?: string
}

export function useLibraryQuery(params?: LibraryQueryParams) {
  return useQuery({
    queryKey: [...LIBRARY_QUERY_KEY, params],
    queryFn: async () => {
      const res = await api.getAssets(params as Record<string, string | number | boolean | undefined>)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取资产库列表失败')
      }
      return res.data.items || []
    },
  })
}

export function useDeleteAssetMutation() {

  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (assetId: string) => {
      const res = await api.deleteAsset(assetId)
      if (!res.success) {
        throw new Error(res.error?.message || '删除资产失败')
      }
      return assetId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY })
    },
  })
}

export function useBatchDeleteAssetsMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (assetIds: string[]) => {
      await Promise.all(
        assetIds.map(async (id) => {
          const res = await api.deleteAsset(id)
          if (!res.success) {
            throw new Error(res.error?.message || `删除资产 ${id} 失败`)
          }
        }),
      )
      return assetIds
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY })
    },
  })
}

export const useDeleteAsset = useDeleteAssetMutation
export const useBatchDeleteAssets = useBatchDeleteAssetsMutation

