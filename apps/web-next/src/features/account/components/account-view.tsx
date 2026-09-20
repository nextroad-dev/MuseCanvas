'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS, type OAuthProviderName } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { UserProfile, OAuthIdentity } from '@/shared/types'
import {
  Calendar,
  Link2,
  Mail,
  ShieldCheck,
  Unlink,
} from 'lucide-react'

export function AccountView() {
  const queryClient = useQueryClient()

  const { data: userProfile, isLoading: profileLoading } = useQuery({
    queryKey: ['account', 'me'],
    queryFn: async () => {
      const res = await api.getMe()
      return res.data || null
    },
  })

  const { data: identities = [], refetch: refetchIdentities } = useQuery({
    queryKey: ['account', 'oauth-identities'],
    queryFn: async () => {
      const res = await api<OAuthIdentity[]>(API_ENDPOINTS.account.oauth)
      return res.data || []
    },
  })

  const unlinkMutation = useMutation({
    mutationFn: async (provider: OAuthProviderName) => {
      const res = await api(API_ENDPOINTS.account.oauthUnlink(provider), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '解除绑定失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', 'oauth-identities'] })
    },
  })

  const isGithubLinked = identities.some((i) => i.provider === 'github')
  const isGoogleLinked = identities.some((i) => i.provider === 'google')

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">账户与安全</h1>
          <p className="text-sm text-muted-foreground">管理您的个人资料与第三方授权绑定。</p>
        </div>

        {/* User profile card */}
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">基本资料</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">登录邮箱</p>
                <p className="text-sm font-medium text-foreground">{userProfile?.email || '—'}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">账户权限</p>
                <p className="text-sm font-medium text-foreground uppercase">{userProfile?.role || 'user'}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">注册时间</p>
                <p className="text-sm font-medium text-foreground">
                  {userProfile?.createdAt ? new Date(userProfile.createdAt).toLocaleDateString() : '—'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Third-party OAuth Identities */}
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">第三方账号绑定</h2>
          <div className="space-y-3">
            {/* GitHub */}
            <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-border p-3">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-xs">GitHub</span>
                <span
                  className={`text-[11px] rounded px-2 py-0.5 font-medium ${
                    isGithubLinked ? 'bg-success-soft text-success' : 'bg-surface-subtle text-muted-foreground'
                  }`}
                >
                  {isGithubLinked ? '已绑定' : '未绑定'}
                </span>
              </div>
              {isGithubLinked ? (
                <button
                  type="button"
                  onClick={() => unlinkMutation.mutate('github')}
                  disabled={unlinkMutation.isPending}
                  className="flex items-center gap-1 text-xs text-danger hover:underline"
                >
                  <Unlink className="h-3 w-3" />
                  解除绑定
                </button>
              ) : (
                <a
                  href={API_ENDPOINTS.account.oauthLinkStart('github')}
                  className="flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <Link2 className="h-3 w-3" />
                  绑定账号
                </a>
              )}
            </div>

            {/* Google */}
            <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-border p-3">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-xs">Google</span>
                <span
                  className={`text-[11px] rounded px-2 py-0.5 font-medium ${
                    isGoogleLinked ? 'bg-success-soft text-success' : 'bg-surface-subtle text-muted-foreground'
                  }`}
                >
                  {isGoogleLinked ? '已绑定' : '未绑定'}
                </span>
              </div>
              {isGoogleLinked ? (
                <button
                  type="button"
                  onClick={() => unlinkMutation.mutate('google')}
                  disabled={unlinkMutation.isPending}
                  className="flex items-center gap-1 text-xs text-danger hover:underline"
                >
                  <Unlink className="h-3 w-3" />
                  解除绑定
                </button>
              ) : (
                <a
                  href={API_ENDPOINTS.account.oauthLinkStart('google')}
                  className="flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <Link2 className="h-3 w-3" />
                  绑定账号
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
