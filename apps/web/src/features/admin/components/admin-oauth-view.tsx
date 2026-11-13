'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'
import { Alert } from '@/shared/components/ui/alert'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { EmptyState } from '@/shared/components/ui/empty-state'
import { PageHeader } from '@/shared/components/ui/page-header'
import { iconSize } from '@/shared/components/ui/size'
import { queryKeys } from '@/shared/hooks/query-keys'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { clientApi } from '@/shared/services/client-api'
import { AdminOAuthProviderCard } from './admin-oauth-provider-card'

/**
 * OAuth 登录配置页：GitHub / Google 两张卡。
 *
 * 凭据来源有三档（数据库 / 环境变量 / 未配置），只有「已配置」的提供商才能启用；
 * 回调地址由站点地址推导，站点地址未设置时给出前置换算提示。
 */
export function AdminOAuthView() {
  const providersQuery = useQuery({
    queryKey: queryKeys.admin.oauthProviders,
    queryFn: () => clientApi.admin.listOAuthProviders(),
    staleTime: 30_000,
  })

  const providers = providersQuery.data ?? []

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="OAuth 登录"
        description="管理 GitHub / Google 第三方登录的凭据与启停。密钥只写不回显；后台保存后立即接管环境变量中的同名凭据。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void providersQuery.refetch()}
            loading={providersQuery.isFetching}
            icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <Alert tone="info" title="回调地址由站点地址推导">
        请先在「系统配置 → 站点信息」填写 HTTPS 站点地址，否则回调地址会退化为当前访问 origin。把每张卡里的回调地址原样填到对应提供商的 OAuth 应用控制台。
      </Alert>

      {providersQuery.isLoading ? (
        <Card>
          <p role="status" className="text-sm text-muted-foreground">
            正在加载 OAuth 提供商…
          </p>
        </Card>
      ) : null}

      {providersQuery.isError && providersQuery.data === undefined ? (
        <Card>
          <EmptyState
            icon={RefreshCw}
            title="无法加载 OAuth 提供商"
            description={adminErrorMessage(providersQuery.error, '请检查管理员会话与网络后重试。')}
            onAction={() => void providersQuery.refetch()}
            actionLabel="重试"
          />
        </Card>
      ) : null}

      {providers.length === 0 && !providersQuery.isLoading && !providersQuery.isError ? (
        <Card>
          <EmptyState
            title="没有可配置的 OAuth 提供商"
            description="服务端应始终返回 GitHub 与 Google 两个提供商；若列表为空，请检查后端版本。"
            onAction={() => void providersQuery.refetch()}
            actionLabel="重新加载"
          />
        </Card>
      ) : null}

      {providers.length > 0 ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {providers.map((provider) => (
            <AdminOAuthProviderCard key={provider.provider} provider={provider} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
