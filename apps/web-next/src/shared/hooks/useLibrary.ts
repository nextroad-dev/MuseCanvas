'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { Asset } from '@/shared/types'

/** Root key for every library read. `useJobs` invalidates it after a generation
 *  succeeds, and the delete mutations invalidate it too, so both the gallery page and
 *  the image picker keep sharing one cache entry per filter. */
export const LIBRARY_QUERY_KEY = ['library'] as const

/** What `GET /api/library` actually filters server-side. Media kind and the keyword
 *  are real SQL predicates now; anything else (favourites, sort, column count) stays
 *  a client-side concern over the pages fetched so far. */
export interface LibraryQueryParams {
  limit?: number
  q?: string
  kind?: 'image' | 'video'
  /** Restrict to images usable as a generation input (PNG/JPEG). */
  eligible?: boolean
}

export interface LibraryPage {
  items: Asset[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

/** Flatten the accumulated pages into one ordered list. */
export function libraryPageItems(data?: InfiniteData<LibraryPage, string | undefined>): Asset[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

/**
 * Keyset-paginated library list. `cursor` is opaque and server-issued, so a page can
 * only ever contain rows the current user owns.
 */
export function useLibraryInfiniteQuery(params: LibraryQueryParams = {}, { enabled = true } = {}) {
  return useInfiniteQuery<LibraryPage, Error, InfiniteData<LibraryPage, string | undefined>, readonly unknown[], string | undefined>({
    queryKey: [...LIBRARY_QUERY_KEY, 'page', params] as const,
    enabled,
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const res = await api.getAssets({ ...params, cursor: pageParam } as Record<string, string | number | boolean | undefined>)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取资产库列表失败')
      }
      return {
        items: res.data.items || [],
        total: res.data.total ?? 0,
        hasMore: Boolean(res.data.hasMore),
        nextCursor: res.data.nextCursor,
      }
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor ?? undefined : undefined),
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

