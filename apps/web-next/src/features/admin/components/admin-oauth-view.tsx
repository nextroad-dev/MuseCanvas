'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS, type OAuthProviderName } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminOAuthProvider } from '@/shared/types'
import { Check, Loader2, RefreshCw, Save, ShieldCheck } from 'lucide-react'

export function AdminOAuthView() {
  const queryClient = useQueryClient()
  const [statusMsg, setStatusMsg] = useState('')

  const {
    data: providers = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'oauth-providers'],
    queryFn: async () => {
      const res = await api<AdminOAuthProvider[]>(API_ENDPOINTS.admin.oauthProviders)
      return res.data || []
    },
  })


  const toggleMutation = useMutation({
    mutationFn: async ({ provider, enabled }: { provider: string; enabled: boolean }) => {
      const res = await api(API_ENDPOINTS.admin.oauthProvider(provider as OAuthProviderName), {
        method: 'PATCH',
        body: { enabled },
      })
      if (!res.success) throw new Error(res.error?.message || '更新状态失败')
      return res.data
    },
    onSuccess: () => {
      setStatusMsg('OAuth 提供商状态已更新')
      queryClient.invalidateQueries({ queryKey: ['admin', 'oauth-providers'] })
    },
    onError: (err: any) => {
      setStatusMsg(err.message || '更新状态失败')
    },
  })

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">OAuth 登录提供商</h1>
          <p className="text-sm text-muted-foreground">配置第三方账号认证源（GitHub, Google），支持一键登录与账号绑定。</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      {statusMsg && (
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-3 text-xs text-foreground">
          {statusMsg}
        </div>
      )}

      <div className="space-y-4">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          </div>
        ) : providers.length > 0 ? (
          providers.map((p) => (
            <div
              key={p.provider}
              className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface p-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-foreground text-sm uppercase">{p.provider}</h3>
                  <span
                    className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ${
                      p.enabled ? 'bg-success-soft text-success' : 'bg-surface-subtle text-muted-foreground'
                    }`}
                  >
                    {p.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Client ID:{' '}
                  <span className="font-mono">
                    {p.clientId ? `${p.clientId.slice(0, 8)}...` : '未配置'}
                  </span>
                </p>
              </div>

              <button
                type="button"
                onClick={() => toggleMutation.mutate({ provider: p.provider, enabled: !p.enabled })}
                className={`rounded-[var(--radius-control)] border px-3 py-1.5 text-xs font-medium transition-colors ${
                  p.enabled
                    ? 'border-border bg-surface hover:bg-surface-subtle text-foreground'
                    : 'border-accent bg-accent text-accent-contrast hover:bg-accent-hover'
                }`}
              >
                {p.enabled ? '停用此登录' : '启用此登录'}
              </button>
            </div>
          ))
        ) : (
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
            暂无 OAuth 提供商
          </div>
        )}
      </div>
    </div>
  )
}
