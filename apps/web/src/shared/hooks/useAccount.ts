'use client'

// 账户聚合读取：会话用户 + 已绑定第三方身份（GET /session + /account/oauth）。

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import type { AccountDto, OAuthIdentityDto } from '@/shared/types'
import { queryKeys } from './query-keys'
import { useSession } from './useSession'

export function useAccount(): UseQueryResult<AccountDto> {
  const session = useSession()
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: () => clientApi.account.get(),
    enabled: Boolean(session.data),
    staleTime: 30_000,
  })
}

export function useLinkedOAuthIdentities(): UseQueryResult<OAuthIdentityDto[]> {
  const session = useSession()
  return useQuery({
    queryKey: [...queryKeys.account, 'oauth'] as const,
    queryFn: () => clientApi.account.getOAuthIdentities(),
    enabled: Boolean(session.data),
    staleTime: 30_000,
  })
}
