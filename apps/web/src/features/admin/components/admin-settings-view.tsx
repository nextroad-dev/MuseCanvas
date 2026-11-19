'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowClockwiseIcon as RefreshCw,
  DatabaseIcon,
  GearSixIcon,
  HardDrivesIcon as HardDrives,
  PlugsConnectedIcon,
} from '@phosphor-icons/react'
import type { SetupConfigDto } from '@musecanvas/contracts'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Tabs,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminSetupConfig,
  useAdminSetupDatabase,
  useTestAdminDatabase,
} from '@/shared/hooks/useAdmin'
import { queryKeys } from '@/shared/hooks/query-keys'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { clientApi } from '@/shared/services/client-api'
import { AdminSettingsGeneral } from './admin-settings-general'
import { AdminSettingsSmtp } from './admin-settings-smtp'
import { AdminSettingsStorage } from './admin-settings-storage'
import { AdminSettingsRuntime } from './admin-settings-runtime'

type Section = 'general' | 'smtp' | 'storage' | 'runtime'

/**
 * 系统配置页：站点/注册、SMTP、对象存储、运行时限制四个分区。
 *
 * 读取统一走 `GET /setup/config` 与 `GET /setup/database`（管理员可直接访问向导端点），
 * 写入用 `POST /setup/*`；密钥字段只写不回显。
 * 保存/测试成功后用返回 DTO 覆盖当前分区，避免整页闪烁与草稿丢失。
 */
export function AdminSettingsView() {
  const [section, setSection] = useState<Section>('general')
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const configQuery = useAdminSetupConfig()
  const databaseQuery = useAdminSetupDatabase()
  const testDatabaseMutation = useTestAdminDatabase()
  const statusQuery = useQuery({
    queryKey: queryKeys.setup.status,
    queryFn: () => clientApi.setup.getStatus(),
    staleTime: 60_000,
  })

  const config = configQuery.data
  const status = statusQuery.data
  const database = databaseQuery.data ?? config?.database

  function applySection<K extends keyof SetupConfigDto>(key: K, value: SetupConfigDto[K]) {
    queryClient.setQueryData<SetupConfigDto>(queryKeys.setup.config, (current) =>
      current ? { ...current, [key]: value } : current,
    )
  }

  function handleRefresh() {
    void configQuery.refetch()
    void databaseQuery.refetch()
    void statusQuery.refetch()
  }

  function handleTestDatabase() {
    testDatabaseMutation.mutate(undefined, {
      onSuccess: (result) => {
        void databaseQuery.refetch()
        if (result.ok && result.reachable) {
          toast.success('数据库连接验证成功')
        } else {
          toast.error('数据库连接不可用', result.errorCode ?? '请检查数据库服务状态。')
        }
      },
      onError: (error) => {
        toast.error('数据库连接探测失败', adminErrorMessage(error))
      },
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="系统配置"
        description="实例初始化后的站点、邮件、对象存储与运行时参数维护入口。字段留空表示保持原值；密钥只写不回显。"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.xs,
              )}
            >
              <GearSixIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
            </span>
            <span className="text-caption font-medium text-muted-foreground">实例运维</span>
          </div>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={configQuery.isFetching || databaseQuery.isFetching}
            leadingIcon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
                  controlSquare.md,
                )}
              >
                <HardDrives weight="duotone" aria-hidden="true" className={iconSize.md} />
              </span>
              <div className="flex flex-col gap-0.5">
                <CardTitle level={2}>实例状态与数据库探测</CardTitle>
                <CardDescription>初始化完成情况与数据库连接摘要；配置修订号用于判断是否有并发修改。</CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status?.setupComplete ? 'success' : 'warning'} dot>
                {status?.setupComplete ? '初始化已完成' : '初始化未完成'}
              </Badge>
              {typeof config?.site.revision === 'number' ? (
                <Badge tone="neutral">配置修订 #{config.site.revision}</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardBody className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border/70 bg-tonal px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DatabaseIcon weight="duotone" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0 text-muted-foreground')} />
              {database ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span>
                    数据库：<span className="font-mono text-xs">{database.driver}</span>
                    {database.connection.host ? ` · ${database.connection.host}:${database.connection.port ?? ''}` : ''}
                    {database.connection.database ? ` / ${database.connection.database}` : ''}
                    {database.serverVersion ? ` · ${database.serverVersion}` : ''}
                  </span>
                  <Badge tone={database.reachable ? 'success' : 'danger'} dot>
                    {database.reachable ? '连接正常' : '连接不可用'}
                  </Badge>
                  {database.schemaVersion ? (
                    <Badge tone="neutral">Schema {database.schemaVersion}</Badge>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">数据库状态暂不可用。</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {status?.completedAt ? (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  完成于 {formatDateTime(status.completedAt)}
                </span>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestDatabase}
                loading={testDatabaseMutation.isPending}
                leadingIcon={<PlugsConnectedIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
              >
                探测数据库
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {configQuery.isError && !config ? (
        <Card>
          <EmptyState
            icon={RefreshCw}
            title="无法加载系统配置"
            description={adminErrorMessage(configQuery.error, '请检查管理员会话与网络后重试。')}
            onAction={() => void configQuery.refetch()}
            actionLabel="重试"
          />
        </Card>
      ) : null}

      {!config && configQuery.isLoading ? (
        <Card>
          <p role="status" className="text-sm text-muted-foreground">
            正在加载系统配置…
          </p>
        </Card>
      ) : null}

      {config ? (
        <Tabs
          aria-label="系统配置分区"
          variant="segment"
          value={section}
          onChange={(next) => setSection(next as Section)}
          tabs={[
            {
              id: 'general',
              label: '站点与注册',
              content: <AdminSettingsGeneral config={config} onSiteSaved={(site) => applySection('site', site)} />,
            },
            {
              id: 'smtp',
              label: 'SMTP 邮件',
              content: <AdminSettingsSmtp settings={config.smtp} onSaved={(smtp) => applySection('smtp', smtp)} />,
            },
            {
              id: 'storage',
              label: '对象存储',
              content: (
                <AdminSettingsStorage settings={config.storage} onSaved={(storage) => applySection('storage', storage)} />
              ),
            },
            {
              id: 'runtime',
              label: '运行时限制',
              content: (
                <AdminSettingsRuntime settings={config.runtime} onSaved={(runtime) => applySection('runtime', runtime)} />
              ),
            },
          ]}
        />
      ) : null}

      <Alert tone="info" title="写操作会校验来源">
        所有保存与测试请求都受同源（Origin）校验约束；如果出现「请求来源校验失败」，请刷新页面后重试，不要从其它域名转发后台页面。
      </Alert>
    </div>
  )
}
