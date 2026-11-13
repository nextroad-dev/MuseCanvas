'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowClockwiseIcon as Refresh } from '@phosphor-icons/react'
import type { BootstrapCheckKey, SetupStatusResponse } from '@musecanvas/contracts'
import { clientApi } from '@/shared/services/client-api'
import { Alert, Badge, Button, iconSize } from '@/shared/components/ui'
import { formatDateTime } from '@/shared/lib/format'
import { setupQueryKeys } from '../../lib/setup-queries'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import { maskConnectionValue } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface BootstrapStepProps {
  status: SetupStatusResponse
  /** 重新读取 status（bootstrap 段由服务端在读取时自动标记完成）。 */
  onRefresh: () => Promise<unknown>
  onSessionLost: (message: string) => void
}

const CHECK_META: Record<BootstrapCheckKey, { label: string; hint: string }> = {
  database: {
    label: '数据库',
    hint: '检查 DATABASE_URL 指向的 PostgreSQL 是否可连接（服务、端口、凭据、容器网络）。',
  },
  redis: {
    label: '缓存服务',
    hint: '检查 REDIS_URL 与 Redis 服务状态；未配置时会话与限流不可用。',
  },
  masterKey: {
    label: '应用主密钥',
    hint: '在部署环境设置 APP_MASTER_KEY（足够长的随机串）后重启 API 服务。',
  },
  runtime: {
    label: '运行环境',
    hint: 'NODE_ENV 需为 production、development 或 test 之一。',
  },
}

const CHECK_BADGE = {
  ok: { tone: 'success' as const, label: '通过' },
  missing: { tone: 'warning' as const, label: '缺失' },
  error: { tone: 'danger' as const, label: '异常' },
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm text-foreground">{value}</dd>
    </div>
  )
}

/**
 * 环境诊断：`status.bootstrap.checks` 是唯一真源（database/redis/masterKey/runtime）。
 * 这里只读展示，不提供修复入口——修复发生在部署侧；数据库连接摘要与连接测试来自
 * `GET/POST /setup/database`（连接串来自环境变量，不在页面上填写）。
 */
export function BootstrapStep({ status, onRefresh, onSessionLost }: BootstrapStepProps) {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const databaseQuery = useQuery({
    queryKey: setupQueryKeys.database,
    queryFn: () => clientApi.setup.getDatabase(),
    retry: false,
    staleTime: 0,
  })

  useEffect(() => {
    if (databaseQuery.isError && isSetupSessionError(databaseQuery.error)) {
      onSessionLost(describeSetupError(databaseQuery.error, '初始化会话已失效。'))
    }
  }, [databaseQuery.isError, databaseQuery.error, onSessionLost])

  const testDatabase = useMutation({
    mutationFn: () => clientApi.setup.testDatabase(),
    onSuccess: (result) => {
      queryClient.setQueryData(setupQueryKeys.database, result)
      setNotice(
        result.ok
          ? { tone: 'success', text: '数据库连接正常。' }
          : { tone: 'danger', text: '无法连接数据库。请检查 DATABASE_URL 指向的服务与网络后重新检测。' },
      )
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      setNotice({ tone: 'danger', text: describeSetupError(error, '数据库检测失败，请稍后重试。') })
    },
  })

  const bootstrap = status.bootstrap
  const ready = bootstrap?.ready === true
  const database = databaseQuery.data ?? null

  async function refreshAll() {
    if (refreshing) return
    setRefreshing(true)
    setNotice(null)
    try {
      await onRefresh()
      await databaseQuery.refetch()
    } catch (error) {
      if (isSetupSessionError(error)) onSessionLost(describeSetupError(error, '初始化会话已失效。'))
      else setNotice({ tone: 'danger', text: describeSetupError(error, '重新检测失败，请稍后重试。') })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <SetupStepShell
      headingId="setup-bootstrap-title"
      title="环境诊断"
      description="以下检查由服务端启动环境决定，页面只读取结果。未通过项需要在部署侧修复后重新检测。"
      status={<Badge tone={ready ? 'success' : 'danger'}>{ready ? '环境就绪' : '待修复'}</Badge>}
    >
      {notice ? (
        <Alert tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
          {notice.text}
        </Alert>
      ) : null}

      {bootstrap ? (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-border rounded-control bg-tonal px-4">
            {bootstrap.checks.map((check) => {
              const meta = CHECK_META[check.key]
              const badge = CHECK_BADGE[check.status]
              return (
                <li key={check.key} className="flex flex-col gap-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{meta.label}</span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>
                  {check.status === 'ok' ? null : (
                    <p className="text-sm text-muted-foreground [text-wrap:pretty]">
                      {check.message ? `${check.message}。` : ''}
                      {meta.hint}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            检测时间：
            <time dateTime={bootstrap.checkedAt} suppressHydrationWarning>
              {formatDateTime(bootstrap.checkedAt)}
            </time>
          </p>
        </div>
      ) : (
        <Alert tone="warning" role="status" title="尚未读取到环境诊断">
          后端未返回引导检查结果。请稍后重新检测；若持续为空，请确认 API 服务版本与健康状态。
        </Alert>
      )}

      <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">数据库连接</h3>
          {database ? (
            <Badge tone={database.reachable ? 'success' : 'danger'}>
              {database.reachable ? '可连接' : '不可连接'}
            </Badge>
          ) : (
            <Badge tone="neutral">未读取</Badge>
          )}
        </div>

        {databaseQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取数据库状态…
          </p>
        ) : null}

        {databaseQuery.isError ? (
          <Alert tone="warning" role="status" title="无法读取数据库状态">
            {describeSetupError(databaseQuery.error, '请稍后点击“重新检测”。')}
          </Alert>
        ) : null}

        {database ? (
          <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Fact label="驱动" value={database.driver === 'postgres' ? 'PostgreSQL' : 'SQLite'} />
            <Fact label="主机" value={maskConnectionValue(database.connection.host)} />
            <Fact label="端口" value={database.connection.port === null ? '未提供' : String(database.connection.port)} />
            <Fact label="数据库名" value={database.connection.database ?? '未提供'} />
            <Fact label="用户" value={maskConnectionValue(database.connection.user)} />
            <Fact label="服务版本" value={database.serverVersion ?? '未知'} />
            <Fact label="结构版本" value={database.schemaVersion ?? '尚未检测到迁移记录'} />
          </dl>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Refresh weight="bold" aria-hidden="true" className={iconSize.sm} />}
            loading={refreshing}
            disabled={testDatabase.isPending}
            onClick={() => void refreshAll()}
          >
            重新检测
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={testDatabase.isPending}
            disabled={refreshing}
            onClick={() => {
              setNotice(null)
              testDatabase.mutate()
            }}
          >
            测试数据库连接
          </Button>
        </div>
      </div>
    </SetupStepShell>
  )
}
