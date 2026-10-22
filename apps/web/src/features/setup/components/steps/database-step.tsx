'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SetupDatabaseStatus } from '@musecanvas/contracts'
import { Alert, Badge, Button, Radio, RadioGroup } from '@/shared/components/ui'
import {
  databaseDriverCards,
  maskConnectionValue,
  stepDefinition,
} from '../../lib/setup-wizard-state'
import {
  errorCodeOf,
  setupQueryKeys,
  stepErrorMessage,
  testSetupDatabase,
} from '../../lib/setup-requests'
import type { SetupDatabaseTestResult } from '../../lib/setup-requests'
import { StepFrame, StepNotice } from './step-frame'
import type { StepNoticeState } from './step-frame'

const { title, description } = stepDefinition('database')

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm text-foreground">{value}</dd>
    </div>
  )
}

/**
 * Read-only view of the database the server is using. The connection comes from
 * DATABASE_URL at deployment time, so the driver cards show availability only.
 */
export function DatabaseStep({
  database,
  loadError,
}: {
  database: SetupDatabaseStatus | undefined
  loadError: string | null
}) {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<StepNoticeState | null>(null)
  const driverLabelId = 'setup-database-driver-label'
  const cards = databaseDriverCards(database)
  const selected = cards.find((card) => card.selected)?.id

  const recheck = useMutation({
    mutationFn: () => testSetupDatabase(),
    onSuccess: (result: SetupDatabaseTestResult) => {
      queryClient.setQueryData(setupQueryKeys.database, result)
      setNotice(
        result.ok
          ? { tone: 'success', text: '数据库连接正常。' }
          : { tone: 'danger', text: '无法连接数据库。请检查 DATABASE_URL 指向的服务与网络后重新检测。' },
      )
    },
    onError: (err) => {
      setNotice({
        tone: 'danger',
        text: errorCodeOf(err) === 'RATE_LIMITED'
          ? '检测过于频繁，请稍后再试。'
          : stepErrorMessage(err, '数据库检测失败，请稍后重试。'),
      })
    },
  })

  const status = database?.reachable === true ? (
    <Badge tone="success">可连接</Badge>
  ) : database ? (
    <Badge tone="danger">不可连接</Badge>
  ) : (
    <Badge tone="neutral">未检测</Badge>
  )

  return (
    <StepFrame headingId="setup-step-database" title={title} description={description} status={status}>
      <StepNotice notice={notice} />
      {loadError ? (
        <Alert tone="warning" role="status" title="无法读取数据库状态">
          {loadError}
        </Alert>
      ) : null}

      {database ? (
        <dl className="grid min-w-0 gap-4 rounded-control bg-tonal p-4 @min-[560px]/fields:grid-cols-2">
          <Fact label="驱动" value={cards.find((card) => card.selected)?.label ?? database.driver} />
          <Fact label="主机" value={maskConnectionValue(database.connection.host)} />
          <Fact label="端口" value={database.connection.port === null ? '未提供' : String(database.connection.port)} />
          <Fact label="数据库名" value={database.connection.database ?? '未提供'} />
          <Fact label="用户" value={maskConnectionValue(database.connection.user)} />
          <Fact label="服务版本" value={database.serverVersion ?? '未知'} />
          <Fact label="结构版本" value={database.schemaVersion ?? '尚未检测到迁移记录'} />
        </dl>
      ) : null}

      {cards.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-3">
          <span id={driverLabelId} className="text-sm font-medium text-foreground">
            数据库驱动
          </span>
          <RadioGroup aria-labelledby={driverLabelId} value={selected} orientation="vertical">
            {cards.map((card) => (
              <Radio
                key={card.id}
                value={card.id}
                disabled={!card.enabled}
                className="w-full items-start rounded-control border border-border-control bg-surface p-4"
                label={
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-foreground">{card.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {card.enabled ? (card.selected ? '当前使用' : '可用') : card.reason}
                    </span>
                  </span>
                }
              />
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            数据库连接在部署时通过 DATABASE_URL 设置，不能在此修改或切换。
          </p>
        </div>
      ) : null}

      <div>
        <Button
          type="button"
          variant="secondary"
          loading={recheck.isPending}
          disabled={recheck.isPending}
          onClick={() => recheck.mutate()}
        >
          重新检测
        </Button>
      </div>
    </StepFrame>
  )
}
