'use client'

// 图库读取：cursor 分页的 infinite query + 单资产详情（缓存优先）。
// 后端没有 `GET /api/library/:id`（只有 /download），灯箱需要的完整 DTO
// 通常已在网格页的列表缓存里；缓存缺失时回源最近 100 条兜底（契约缺口见报告）。

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import { ApiError } from '@/shared/services/api'
import type { AssetDto, AssetListDto, LibraryFilters } from '@/shared/types'
import { queryKeys } from './query-keys'

export const LIBRARY_PAGE_SIZE = 30

function toQueryParams(filters?: LibraryFilters) {
  return {
    limit: filters?.limit ?? LIBRARY_PAGE_SIZE,
    ...(filters?.q ? { q: filters.q } : {}),
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.eligible ? { eligible: true } : {}),
  }
}

/** Keyset 分页：cursor 由服务端签发（不透明），只可能返回当前用户的行。 */
export function useLibrary(
  filters?: LibraryFilters,
): UseInfiniteQueryResult<InfiniteData<AssetListDto, string | undefined>> {
  const params = toQueryParams(filters)
  return useInfiniteQuery({
    queryKey: queryKeys.library.list(params),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      clientApi.library.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
  })
}

/** 已加载的资产扁平列表（保持服务端顺序）。 */
export function libraryItems(
  data: InfiniteData<AssetListDto, string | undefined> | undefined,
): AssetDto[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

/** 从当前图库缓存里按 id 找资产（灯箱打开时先查已加载页）。 */
export function findCachedAsset(
  queryClient: ReturnType<typeof useQueryClient>,
  assetId: string,
): AssetDto | null {
  for (const [, value] of queryClient.getQueriesData<InfiniteData<AssetListDto, string | undefined>>({
    queryKey: queryKeys.library.list().slice(0, 2),
  })) {
    if (!Array.isArray(value?.pages)) continue
    for (const page of value.pages) {
      if (!Array.isArray(page?.items)) continue
      const found = page.items.find((item) => item?.id === assetId)
      if (found) return found
    }
  }
  return null
}

export function useAssetDetail(assetId: string | null | undefined): UseQueryResult<AssetDto> {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.library.detail(assetId ?? ''),
    enabled: Boolean(assetId),
    staleTime: 30_000,
    queryFn: async () => {
      const cached = findCachedAsset(queryClient, assetId as string)
      if (cached) return cached
      const page = await clientApi.library.list({ limit: 100 })
      const found = page.items.find((item) => item.id === assetId)
      if (!found) throw new ApiError(404, 'NOT_FOUND', '资产不存在或不在最近作品中')
      return found
    },
  })
}

/** 重新签名下载地址（签名 URL 会过期，灯箱下载按钮点按时取新签名）。 */
export function useAssetDownloadUrl() {
  return useMutation({
    mutationFn: (assetId: string) => clientApi.library.download(assetId),
  })
}

export function useDeleteAsset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (assetId: string) => clientApi.library.remove(assetId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
      // 删除资产会连带删除其任务（服务端语义），任务缓存同步失效。
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
    },
  })
}

export function useBatchDeleteAssets() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (assetIds: string[]) => {
      for (const id of assetIds) {
        try {
          await clientApi.library.remove(id)
        } catch (error) {
          // 删除任务会连带移除其他输出；后续选中资产可能已经不存在。
          if (!(error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND'))) {
            throw error
          }
        }
      }
      return assetIds
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
    },
  })
}
