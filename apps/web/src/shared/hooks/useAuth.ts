'use client'

// 认证动作：OTP 请求/校验、退出、OAuth providers 与跳转地址。
// 登录态本身由 useSession 托管；verify 成功直接写入 session 缓存，避免二次 401 闪烁。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import type { AuthSessionResult, OAuthProvider, OAuthProviderInfo, OtpRequestResult } from '@/shared/types'
import { queryKeys } from './query-keys'

export function useAuth() {
  const queryClient = useQueryClient()

  const requestOtpMutation = useMutation({
    mutationFn: (input: { email: string; invitationCode?: string }) =>
      clientApi.auth.requestOtp(input.email, input.invitationCode),
  })

  const verifyOtpMutation = useMutation({
    mutationFn: (input: { email: string; code: string }) =>
      clientApi.auth.verifyOtp(input.email, input.code),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(queryKeys.session, { user })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => clientApi.auth.logout(),
    onSuccess: () => {
      // 会话在 query cache 里，清空全部缓存即退出登录并丢弃按 actor 隔离的数据。
      queryClient.clear()
    },
  })

  return {
    requestOtp: (email: string, invitationCode?: string): Promise<OtpRequestResult> =>
      requestOtpMutation.mutateAsync({ email, ...(invitationCode ? { invitationCode } : {}) }),
    verifyOtp: (email: string, code: string): Promise<AuthSessionResult> =>
      verifyOtpMutation.mutateAsync({ email, code }),
    logout: (): Promise<{ loggedOut: boolean }> => logoutMutation.mutateAsync(),
    requestOtpMutation,
    verifyOtpMutation,
    logoutMutation,
    isAuthenticating: requestOtpMutation.isPending || verifyOtpMutation.isPending,
  }
}

/** 启用中的 OAuth 供应商（GET /auth/oauth/providers）。 */
export function useOAuthProviders() {
  return useQuery<OAuthProviderInfo[]>({
    queryKey: [...queryKeys.session, 'oauth-providers'] as const,
    queryFn: () => clientApi.auth.getOAuthProviders(),
    staleTime: 5 * 60_000,
  })
}

export function oauthLoginUrl(provider: OAuthProvider): string {
  return clientApi.auth.oauthStartUrl(provider)
}

export function oauthLinkUrl(provider: OAuthProvider): string {
  return clientApi.account.oauthLinkUrl(provider)
}
