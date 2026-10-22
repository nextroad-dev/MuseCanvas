'use client'

import type { CSSProperties } from 'react'
import { adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { useQuery,
  useMutation,
  useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS,
  type OAuthProviderName } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminOAuthProvider } from '@/shared/types'
import { useAdminActions } from '../lib/use-admin-actions'
import { AdminActionErrors } from './admin-confirm-dialog'
import { AdminCopyValue } from './admin-copy-value'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminListToolbar } from './admin-list-toolbar'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SkeletonText,
  SkeletonTile,
  Switch,
  iconSize,
} from '@/shared/components/ui'
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'

const oauthQueryKey = ['admin', 'oauth-providers'] as const

const sourceLabel: Record<AdminOAuthProvider['source'], string> = {
  database: '数据库配置',
  environment: '环境变量配置',
  none: '未配置凭据',
}

/** Provider ids are lowercase codes; the display name comes from the payload's label. */
function providerName(provider: AdminOAuthProvider): string {
  return provider.label || provider.provider
}

export function AdminOAuthView() {
  const queryClient = useQueryClient()
  const actions = useAdminActions()

  const {
    data: providersData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: oauthQueryKey,
    queryFn: async () => {
      const res = await api<AdminOAuthProvider[]>(API_ENDPOINTS.admin.oauthProviders)
      if (!res.success) throw new Error(res.error?.message || '读取 OAuth 提供商失败')
      return res.data || []
    },
  })

  const providers = providersData ?? []

  const toggleMutation = useMutation({
    mutationFn: async ({ provider, enabled }: { provider: string; enabled: boolean }) => {
      const res = await api(API_ENDPOINTS.admin.oauthProvider(provider as OAuthProviderName), {
        method: 'PATCH',
        body: { enabled },
      })
      if (!res.success) throw new Error(res.error?.message || '更新状态失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: oauthQueryKey })
    },
  })

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="OAuth 登录提供商"
        description="查看第三方登录配置并管理启停。提供商凭据由初始化流程或服务端环境配置，后台不提供编辑表单。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void refetch()}
            loading={isFetching}
            icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <AdminListToolbar title="登录渠道" description="启停仅影响登录入口，不修改凭据。回调地址可复制到对应提供商控制台。"
        summary={`已载入 ${providers.length} 个提供商 · 已启用 ${providers.filter((provider) => provider.enabled).length} 个`} />
      <AdminActionErrors errors={actions.errors} />
      {providersData !== undefined && <AdminQueryFeedback error={error} hasData label="OAuth 提供商" onRetry={() => { void refetch() }} />}

      {isLoading ? (
        <div className="grid min-w-0 gap-4 @min-[900px]/admin:grid-cols-2" role="status" aria-busy="true">
          <span className="sr-only">正在加载 OAuth 提供商</span>
          {['github', 'google'].map((provider) => (
            <Card key={provider} aria-hidden="true" className="min-w-0 justify-between gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SkeletonText width={provider === 'github' ? '6rem' : '7rem'} />
                  <SkeletonTile className="aspect-auto h-6 w-16 rounded-pill" />
                  <SkeletonTile className="aspect-auto h-6 w-24 rounded-pill" />
                </div>
                <SkeletonText width="15rem" />
                <SkeletonText width="22rem" />
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <SkeletonText width="5rem" />
                <SkeletonTile className="aspect-auto h-5 w-9 rounded-pill" />
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {isError && providersData === undefined ? (
        <EmptyState
          variant="error"
          title="无法加载 OAuth 提供商"
          description={
            error instanceof Error
              ? `${error.message}。请检查管理后台会话与网络后重试。`
              : '加载数据时出现问题，请稍后重试。'
          }
          onAction={() => void refetch()}
          actionLabel="刷新重试"
        />
      ) : null}

      {!isLoading && providersData !== undefined ? (
        providers.length > 0 ? (
          <div className="grid min-w-0 gap-4 @min-[900px]/admin:grid-cols-2">
            {providers.map((p, index) => {
              const name = providerName(p)
              return (
                <Card key={p.provider} className="min-w-0 justify-between gap-6 motion-reveal motion-stagger" style={{ '--stagger-index': index } as CSSProperties}>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-module text-foreground">{name}</h2>
                      <Badge tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? '已启用' : '已停用'}</Badge>
                      <Badge tone={p.source === 'none' ? 'warning' : 'neutral'}>{sourceLabel[p.source]}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Client ID：
                      <span className="font-mono text-foreground">
                        {p.clientId ? `${p.clientId.slice(0, 8)}…` : '未配置'}
                      </span>
                    </p>
                    <div className="min-w-0 text-sm text-muted-foreground">
                      <p className="mb-1">回调地址</p>
                      <AdminCopyValue value={p.redirectUri || undefined} label={`${name} 回调地址`} unavailable="未配置回调地址" />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-tonal p-3">
                    <span className="text-sm font-medium text-muted-foreground">启用登录</span>
                    <Switch
                      checked={p.enabled}
                      aria-label={`${name} 登录`}
                      disabled={actions.isToggleBlocked(p.provider)}
                      onCheckedChange={(enabled) =>
                        actions.run(p.provider, name, () => toggleMutation.mutateAsync({ provider: p.provider, enabled }), enabled ? 'OAuth 登录已启用' : 'OAuth 登录已停用', 'toggle')
                      }
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <EmptyState
              variant="first-use"
              objectName="OAuth 登录"
              title="欢迎使用 OAuth 登录"
              description="在这里你可以启用或停用 GitHub、Google 登录。提供商凭据由服务端环境变量或初始化流程写入，管理后台不负责创建提供商。"
              actionLabel="刷新提供商列表"
              onAction={() => void refetch()}
            >
              <p className="max-w-reading text-sm text-muted-foreground">
                如果列表持续为空，请先在部署配置中为实例填写对应提供商的 Client ID 与 Client Secret。
              </p>
            </EmptyState>
          </Card>
        )
      ) : null}
    </div>
  )
}
