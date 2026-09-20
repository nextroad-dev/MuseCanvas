'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import { useAccountCredits } from '@/shared/hooks/useAccount'
import type { UserProfile, OAuthIdentity, LedgerEntry } from '@/shared/types'
import {
  Calendar,
  Coins,
  History,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from 'lucide-react'

export function AccountView() {
  const queryClient = useQueryClient()
  const { data: credits, isLoading: creditsLoading, refetch: refetchCredits } = useAccountCredits()

  const { data: userProfile, isLoading: profileLoading } = useQuery({
    queryKey: ['account', 'me'],
    queryFn: async () => {
      const res = await api<UserProfile>('/api/auth/me')
      return res.data || null
    },
  })

  const { data: identities = [], refetch: refetchIdentities } = useQuery({
    queryKey: ['account', 'oauth-identities'],
    queryFn: async () => {
      const res = await api<{ items: OAuthIdentity[] }>('/api/account/oauth-identities')
      return res.data?.items || []
    },
  })

  const { data: ledger = [], isLoading: ledgerLoading, refetch: refetchLedger } = useQuery({
    queryKey: ['account', 'ledger'],
    queryFn: async () => {
      const res = await api<{ items: LedgerEntry[] }>('/api/account/ledger?limit=20')
      return res.data?.items || []
    },
  })

  const unlinkMutation = useMutation({
    mutationFn: async (provider: string) => {
      const res = await api(`/api/account/oauth-identities/${provider}`, { method: 'DELETE' })
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
          <p className="text-sm text-muted-foreground">管理您的个人资料、积分配额与第三方授权绑定。</p>
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

        {/* Credits Card */}
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">积分余额</h2>
            <button
              type="button"
              onClick={() => {
                refetchCredits()
                refetchLedger()
              }}
              className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-[var(--radius-control)] border border-border/80 bg-surface-subtle p-4">
              <span className="text-xs text-muted-foreground">可用积分</span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight text-foreground font-mono">
                  {credits ? credits.availableCredits : '—'}
                </span>
                <span className="text-xs text-muted-foreground">点</span>
              </div>
            </div>

            <div className="rounded-[var(--radius-control)] border border-border/80 bg-surface-subtle p-4">
              <span className="text-xs text-muted-foreground">冻结中积分 (生图中)</span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight text-muted-foreground font-mono">
                  {credits ? credits.reservedCredits : '0'}
                </span>
                <span className="text-xs text-muted-foreground">点</span>
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
                  href="/api/auth/oauth/github/start"
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
                  href="/api/auth/oauth/google/start"
                  className="flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <Link2 className="h-3 w-3" />
                  绑定账号
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Ledger Transaction History */}
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">积分收支明细</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">类型</th>
                  <th className="px-3 py-2 font-medium">点数变动</th>
                  <th className="px-3 py-2 font-medium">备注说明</th>
                  <th className="px-3 py-2 font-medium">记录时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ledgerLoading ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </td>
                  </tr>
                ) : ledger.length > 0 ? (
                  ledger.map((entry) => {
                    const delta = entry.availableDelta
                    return (
                      <tr key={entry.id} className="hover:bg-surface-subtle/50">
                        <td className="px-3 py-2 font-medium capitalize">{entry.operation}</td>
                        <td
                          className={`px-3 py-2 font-mono font-bold ${
                            delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-muted-foreground'
                          }`}
                        >
                          {delta > 0 ? `+${delta}` : delta}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{entry.note || '—'}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    )
                  })

                ) : (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-muted-foreground">
                      暂无积分明细
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
