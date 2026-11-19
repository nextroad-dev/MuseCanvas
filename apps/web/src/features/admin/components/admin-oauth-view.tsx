'use client'

import { ArrowClockwiseIcon as RefreshCw, ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  controlSquare,
  iconSize,
} from '@/shared/components/ui'
import { useAdminOAuthProviders } from '@/shared/hooks/useAdmin'
import { cn } from '@/shared/lib/cn'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { AdminOAuthProviderCard } from './admin-oauth-provider-card'

/**
 * OAuth 登录配置页：GitHub / Google 两张卡。
 *
 * 凭据来源有三档（数据库 / 环境变量 / 未配置），只有「已配置」的提供商才能启用；
 * 回调地址由站点地址推导，站点地址未设置时给出前置换算提示。
 */
export function AdminOAuthView() {
  const providersQuery = useAdminOAuthProviders()

  const providers = providersQuery.data ?? []
  const enabledCount = providers.filter((provider) => provider.enabled).length

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="OAuth 登录"
        description="管理 GitHub / Google 第三方登录的凭据与启停。密钥只写不回显；后台保存后立即接管环境变量中的同名凭据。"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.xs,
              )}
            >
              <ShieldCheck weight="duotone" aria-hidden="true" className={iconSize.sm} />
            </span>
            <span className="text-caption font-medium text-muted-foreground">身份认证</span>
            {providers.length > 0 ? (
              <Badge tone={enabledCount > 0 ? 'success' : 'neutral'} dot={enabledCount > 0}>
                已启用 {enabledCount}/{providers.length}
              </Badge>
            ) : null}
          </div>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void providersQuery.refetch()}
            loading={providersQuery.isFetching}
            leadingIcon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <Alert tone="info" title="回调地址由站点地址推导">
        请先在「系统配置 → 站点信息」填写 HTTPS 站点地址，否则回调地址会退化为当前访问 origin。把每张卡里的回调地址原样填到对应提供商的 OAuth 应用控制台。
      </Alert>

      {providersQuery.isLoading ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2" role="status" aria-label="正在加载 OAuth 提供商">
          <Card className="gap-4">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" />
          </Card>
          <Card className="gap-4">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" />
          </Card>
        </div>
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
