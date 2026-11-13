'use client'

// 会话（GET /api/session）：`null` 表示未登录，401 不重试、不视为错误。
// 服务端状态只放 TanStack Query；登录表单的 step/email 在 auth-ui-store。

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import { isApiError } from '@/shared/services/api'
import type { SessionDto } from '@/shared/types'
import { queryKeys } from './query-keys'

export { queryKeys }

/** 未登录返回 null；其他错误（后端宕机等）照常抛出。 */
export function useSession(): UseQueryResult<SessionDto | null> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: async () => {
      try {
        return await clientApi.session.get()
      } catch (error) {
        if (isApiError(error) && (error.status === 401 || error.code === 'UNAUTHORIZED')) return null
        if (isApiError(error) && error.status === 0 && error.code === 'NETWORK_ERROR') {
          throw error
        }
        throw error
      }
    },
    staleTime: 60_000,
    retry: (failureCount, error) =>
      isApiError(error) && error.status === 401 ? false : failureCount < 2,
    refetchOnWindowFocus: true,
  })
}

/** 当前登录用户 id（未登录 `''`），用于按 actor 隔离缓存。 */
export function useCurrentActorId(): string {
  return useSession().data?.user.id ?? ''
}
