'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowClockwiseIcon as RefreshCw, HardDrivesIcon as HardDrives } from '@phosphor-icons/react'
import type { SetupConfigDto } from '@musecanvas/contracts'
import { Alert } from '@/shared/components/ui/alert'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { EmptyState } from '@/shared/components/ui/empty-state'
import { PageHeader } from '@/shared/components/ui/page-header'
import { Tabs } from '@/shared/components/ui/tabs'
import { iconSize } from '@/shared/components/ui/size'
import { queryKeys } from '@/shared/hooks/query-keys'
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
 * 读取统一走 `GET /setup/config`（管理员可直接访问向导端点），写入用 `POST /setup/*`；
 * 密钥字段只写不回显。保存/测试成功后用返回 DTO 覆盖当前分区，避免整页闪烁与草稿丢失。
 */
export function AdminSettingsView() {
  const [section, setSection] = useState<Section>('general')
  const queryClient = useQueryClient()

  const configQuery = useQuery({
    queryKey: queryKeys.setup.config,
    queryFn: () => clientApi.setup.getConfig(),
    staleTime: 30_000,
  })
  const statusQuery = useQuery({
    queryKey: queryKeys.setup.status,
    queryFn: () => clientApi.setup.getStatus(),
    staleTime: 60_000,
  })

  const config = configQuery.data
  const status = statusQuery.data
  const database = config?.database

  function applySection<K extends keyof SetupConfigDto>(key: K, value: SetupConfigDto[K]) {
    queryClient.setQueryData<SetupConfigDto>(queryKeys.setup.config, (current) =>
      current ? { ...current, [key]: value } : current,
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="系统配置"
        description="实例初始化后的站点、邮件、对象存储与运行时参数维护入口。字段留空表示保持原值；密钥只写不回显。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void configQuery.refetch()}
            loading={configQuery.isFetching}
            icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <Card className="border border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"
              >
                <HardDrives size={18} weight="duotone" />
              </span>
              <div>
                <CardTitle level={2}>实例状态</CardTitle>
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
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-canvas px-4 py-3">
            {database ? (
              <p className="text-sm text-foreground">
                数据库：<span className="font-mono text-xs">{database.driver}</span>
                {database.connection.host ? ` · ${database.connection.host}:${database.connection.port ?? ''}` : ''}
                {database.serverVersion ? ` · ${database.serverVersion}` : ''}
                <span className={database.reachable ? 'text-success' : 'text-danger'}>
                  {database.reachable ? ' · 连接正常' : ' · 连接不可用'}
                </span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">数据库状态暂不可用。</p>
            )}
            {status?.completedAt ? (
              <span className="font-mono text-xs text-muted-foreground">
                完成于 {formatDateTime(status.completedAt)}
              </span>
            ) : null}
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
