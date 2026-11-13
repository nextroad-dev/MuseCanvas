'use client'

// 对话（canvas）列表/详情 + 创建/改标题/删除。canvas 即「对话」，
// 首次发送或「新建对话」时才创建，绝不在 mount/SSR 时隐式创建。

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
import type {
  CanvasDto,
  CanvasListItemDto,
  CanvasListPageDto,
  CreateCanvasRequest,
  UpdateCanvasRequest,
} from '@/shared/types'
import { queryKeys } from './query-keys'
import { useCurrentActorId } from './useSession'

export { queryKeys }

const CANVAS_PAGE_SIZE = 20

/** 对话列表（cursor 分页）；未登录时禁用，避免 RSC/SSR 期间触发。 */
export function useCanvases(): UseInfiniteQueryResult<
  InfiniteData<CanvasListPageDto, string | undefined>
> {
  const actorId = useCurrentActorId()
  return useInfiniteQuery({
    queryKey: queryKeys.canvases.list(),
    enabled: actorId !== '',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      clientApi.canvases.list({
        limit: CANVAS_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
}

export function canvasPagesToItems(
  data: InfiniteData<CanvasListPageDto, string | undefined> | undefined,
): CanvasListItemDto[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

export function useCanvas(canvasId: string | null | undefined): UseQueryResult<CanvasDto> {
  const actorId = useCurrentActorId()
  return useQuery({
    queryKey: queryKeys.canvases.detail(canvasId ?? ''),
    queryFn: () => clientApi.canvases.detail(canvasId as string),
    enabled: Boolean(actorId && canvasId),
  })
}

export function useCreateCanvas() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCanvasRequest = {}) => clientApi.canvases.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.canvases.root })
    },
  })
}

export function useUpdateCanvas() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateCanvasRequest }) =>
      clientApi.canvases.update(input.id, input.body),
    onSuccess: (canvas) => {
      queryClient.setQueryData(queryKeys.canvases.detail(canvas.id), canvas)
      void queryClient.invalidateQueries({ queryKey: queryKeys.canvases.list() })
    },
  })
}

export function useDeleteCanvas() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (canvasId: string) => clientApi.canvases.remove(canvasId),
    onSuccess: (_result, canvasId) => {
      queryClient.removeQueries({ queryKey: queryKeys.canvases.detail(canvasId) })
      queryClient.removeQueries({ queryKey: queryKeys.canvasAgent.history(canvasId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.canvases.list() })
    },
  })
}
