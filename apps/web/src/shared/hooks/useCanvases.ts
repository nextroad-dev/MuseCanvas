'use client'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CanvasListItemDto, CanvasListPageDto, CreateCanvasRequest } from '@musecanvas/contracts'
import { canvasApi } from '@/features/generate/lib/canvas-api'
import {
  CANVASES_QUERY_KEY,
  canvasDetailQueryKey,
  canvasListQueryKey,
} from '@/features/generate/lib/canvas-query-keys'
import { useAccountQuery } from './useAccount'

/** Every canvas query is scoped by the authenticated actor, so logging out and
 *  signing in as someone else cannot reuse the previous actor's cached list. */
export { CANVASES_QUERY_KEY, canvasDetailQueryKey, canvasListQueryKey }

/**
 * The signed-in actor id for query keys.
 *
 * The session query (`useAccountQuery`) is the single source of truth for the
 * signed-in user, so every actor-scoped query stays disabled until it resolves.
 */
export function useCurrentActorId(): string {
  const account = useAccountQuery()
  return account.data?.id ?? ''
}

/** Conversation list with cursor "load more". Disabled until an actor is known,
 *  so it never fires during SSR or before the session resolves. */
export function useCanvasesQuery() {
  const actorId = useCurrentActorId()
  return useInfiniteQuery({
    queryKey: canvasListQueryKey(actorId),
    enabled: actorId !== '',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      canvasApi.list({ limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page: CanvasListPageDto) => page.nextCursor ?? undefined,
  })
}

export function useCanvasDetailQuery(canvasId: string | null) {
  const actorId = useCurrentActorId()
  return useQuery({
    queryKey: canvasDetailQueryKey(actorId, canvasId ?? ''),
    enabled: Boolean(actorId && canvasId),
    queryFn: () => canvasApi.detail(canvasId as string),
  })
}

/**
 * Create a conversation. This is a mutation on purpose: a canvas is created only
 * on an explicit user action (the first message or the "new conversation" button),
 * never on mount/SSR/preload. `baseRevision` for the first request comes from the
 * created document.
 */
export function useCreateCanvasMutation() {
  const queryClient = useQueryClient()
  const actorId = useCurrentActorId()
  return useMutation({
    mutationFn: (body: CreateCanvasRequest) => canvasApi.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: canvasListQueryKey(actorId) })
    },
  })
}

/** Flatten the infinite list pages newest-first into one display list. */
export function flattenCanvasPages(pages: CanvasListPageDto[] | undefined): CanvasListItemDto[] {
  return (pages ?? []).flatMap((page) => page.items)
}
