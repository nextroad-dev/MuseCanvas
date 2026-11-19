'use client'

// 安装向导客户端岛：单列居中卡片流、状态读取、步骤切换与跨步骤会话失效处理。
// 完成状态只读 `GET /setup/status`；`GET /setup/config` 成功即代表初始化访问已开放
// （claim 会话 / 管理员会话 / claim-optional 的开放模式），因此不需要额外探测。

import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CheckCircleIcon,
  CircleIcon,
} from '@phosphor-icons/react'
import type { SetupConfigDto, SetupStatusResponse } from '@musecanvas/contracts'

import { Alert, Button, DropdownMenu, buttonVariants, iconSize } from '@/shared/components/ui'
import type { DropdownMenuItem } from '@/shared/components/ui'
import { APP_ROUTES, loginHref } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupSessionError } from '../lib/setup-errors'
import { setupQueryKeys } from '../lib/setup-queries'
import {
  isSetupClaimRequired,
  resolveActiveStepIndex,
  resolveSetupSteps,
  setupStepPosition,
} from '../lib/setup-steps'
import type { SetupStepId } from '../lib/setup-steps'
import { SetupCompleteView } from './setup-complete-view'
import { SetupStepProvider, SetupStepShell } from './setup-step-shell'
import { AdminStep } from './steps/admin-step'
import { BootstrapStep } from './steps/bootstrap-step'
import { ClaimStep } from './steps/claim-step'
import { CompleteStep } from './steps/complete-step'
import { RuntimeStep } from './steps/runtime-step'
import { SiteStep } from './steps/site-step'
import { SmtpStep } from './steps/smtp-step'
import { StorageStep } from './steps/storage-step'
import { TemplatesStep } from './steps/templates-step'

export interface SetupWizardProps {
  initialStatus: SetupStatusResponse
  /** RSC 已成功读到 `/setup/config` 时传入（说明初始化访问已开放）。 */
  initialConfig: SetupConfigDto | null
  /** `?step=` 深链。 */
  initialStep: SetupStepId | null
}

export function SetupWizard({ initialStatus, initialConfig, initialStep }: SetupWizardProps) {
  const queryClient = useQueryClient()
  const [hasAccess, setHasAccess] = useState(Boolean(initialConfig))
  const [stepId, setStepId] = useState<SetupStepId | null>(initialStep)
  const [templatesSkipped, setTemplatesSkipped] = useState(false)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)

  const statusQuery = useQuery({
    queryKey: setupQueryKeys.status,
    queryFn: () => clientApi.setup.getStatus(),
    initialData: initialStatus,
    staleTime: 0,
    retry: false,
  })

  const configQuery = useQuery({
    queryKey: setupQueryKeys.config,
    queryFn: () => clientApi.setup.getConfig(),
    enabled: hasAccess,
    ...(initialConfig ? { initialData: initialConfig } : {}),
    staleTime: 0,
    retry: false,
  })

  const status = statusQuery.data ?? initialStatus
  const config = configQuery.data ?? null

  // 任意受保护读取返回会话错误：退回领取步骤，并让用户看到原因。
  useEffect(() => {
    if (!configQuery.isError || !hasAccess) return
    if (!isSetupSessionError(configQuery.error)) return
    queryClient.removeQueries({ queryKey: setupQueryKeys.config })
    setHasAccess(false)
    setSessionNotice(describeSetupError(configQuery.error, '初始化会话已失效。'))
    setStepId('claim')
  }, [configQuery.isError, configQuery.error, hasAccess, queryClient])

  const steps = resolveSetupSteps({
    hasAccess,
    claimRequired: status.claimRequired,
    setupComplete: status.setupComplete,
    sections: status.sections,
    bootstrapReady: status.bootstrap?.ready === true,
    templatesSkipped,
  })
  const activeIndex = resolveActiveStepIndex(steps, stepId)
  const active = steps[activeIndex] ?? steps[0]

  const refresh = useCallback(async () => {
    await statusQuery.refetch()
    if (hasAccess) await configQuery.refetch()
  }, [statusQuery, configQuery, hasAccess])

  const goTo = useCallback(
    (index: number) => {
      const target = steps[index]
      if (!target) return
      setStepId(target.id)
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `${APP_ROUTES.setup}?step=${target.id}`)
      }
    },
    [steps],
  )

  const goToStepId = useCallback(
    (targetId: SetupStepId) => {
      const index = steps.findIndex((step) => step.id === targetId)
      if (index >= 0) goTo(index)
    },
    [steps, goTo],
  )

  /** 步骤成功后：先刷新服务端状态（段完成 / bootstrap 标记），再前进。 */
  const advance = useCallback(async () => {
    await refresh()
    const nextIndex = activeIndex + 1
    if (steps[nextIndex]) goTo(nextIndex)
  }, [refresh, activeIndex, steps, goTo])

  const handleSessionLost = useCallback(
    (message: string) => {
      setSessionNotice(message)
      setHasAccess(false)
      setTemplatesSkipped(false)
      queryClient.removeQueries({ queryKey: setupQueryKeys.config })
      if (isSetupClaimRequired(status.claimRequired)) setStepId('claim')
      void statusQuery.refetch()
    },
    [queryClient, status.claimRequired, statusQuery],
  )

  const handleClaimed = useCallback(async () => {
    setSessionNotice(null)
    setHasAccess(true)
    await statusQuery.refetch()
    const claimIndex = steps.findIndex((step) => step.id === 'claim')
    goTo(claimIndex >= 0 ? Math.min(claimIndex + 1, steps.length - 1) : 0)
  }, [statusQuery, steps, goTo])

  if (status.setupComplete) {
    return <SetupCompleteView completedAt={status.completedAt} />
  }

  const claimRequired = isSetupClaimRequired(status.claimRequired)
  const openSetupNotice = !claimRequired && activeIndex === 0
  const positionLabel = setupStepPosition(steps, activeIndex)
  const nextLabel = active.id === 'templates' && !active.complete ? '跳过此步' : '下一步'
  const canAdvance = active.id === 'templates' ? true : active.complete

  const stepMenuItems: DropdownMenuItem[] = steps.map((step, index) => ({
    id: step.id,
    label: `${index + 1}. ${step.title}`,
    selected: index === activeIndex,
    disabled: claimRequired && !hasAccess && step.id !== 'claim',
    icon: step.complete ? (
      <CheckCircleIcon weight="fill" aria-hidden="true" className={cn(iconSize.sm, 'text-success')} />
    ) : index === activeIndex ? (
      <CircleIcon weight="fill" aria-hidden="true" className={cn(iconSize.xs, 'text-primary')} />
    ) : (
      <CircleIcon weight="regular" aria-hidden="true" className={cn(iconSize.xs, 'text-muted-foreground')} />
    ),
    onSelect: () => goTo(index),
  }))

  const stepFooter = (
    <nav aria-label="步骤导航" className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div className="justify-self-start">
        <Button
          variant="outline"
          size="md"
          onClick={() => goTo(activeIndex - 1)}
          disabled={activeIndex === 0}
          leadingIcon={<CaretLeftIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
        >
          上一步
        </Button>
      </div>

      <div className="justify-self-center">
        <DropdownMenu
          side="top"
          align="start"
          size="sm"
          menuLabel="切换初始化步骤"
          items={stepMenuItems}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="font-mono text-xs tabular-nums text-muted-foreground"
              trailingIcon={<CaretUpDownIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            >
              {positionLabel}
            </Button>
          }
        />
      </div>

      <div className="justify-self-end">
        {active.id === 'complete' ? null : (
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              if (active.id === 'templates' && !active.complete) {
                setTemplatesSkipped(true)
                goTo(activeIndex + 1)
                return
              }
              void advance()
            }}
            disabled={!canAdvance}
            trailingIcon={<CaretRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            {nextLabel}
          </Button>
        )}
      </div>
    </nav>
  )

  function renderStep() {
    if (active.id === 'claim') {
      return <ClaimStep hasAccess={hasAccess} bootstrap={status.bootstrap} onClaimed={handleClaimed} />
    }
    if (active.id === 'bootstrap') {
      return <BootstrapStep status={status} onRefresh={refresh} onSessionLost={handleSessionLost} />
    }
    if (!config) {
      return (
        <SetupStepShell headingId="setup-step-blocked" title={active.title} description={active.description}>
          <Alert
            tone="warning"
            role="status"
            title="暂时无法读取初始化配置"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
                  重试
                </Button>
                <a
                  href={loginHref(APP_ROUTES.setup)}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  以管理员登录
                </a>
              </div>
            }
          >
            配置读取失败或初始化访问未开放。请刷新页面；如果仍无法继续，重新领取初始化码，或使用已有的管理员账号登录。
          </Alert>
        </SetupStepShell>
      )
    }

    switch (active.id) {
      case 'site':
        return <SiteStep config={config} complete={active.complete} onDone={advance} onSessionLost={handleSessionLost} />
      case 'smtp':
        return <SmtpStep config={config} complete={active.complete} onDone={advance} onSessionLost={handleSessionLost} />
      case 'admin':
        return (
          <AdminStep
            complete={active.complete}
            smtpReady={steps.find((step) => step.id === 'smtp')?.complete === true}
            onDone={advance}
            onSessionLost={handleSessionLost}
          />
        )
      case 'storage':
        return (
          <StorageStep config={config} complete={active.complete} onDone={advance} onSessionLost={handleSessionLost} />
        )
      case 'runtime':
        return (
          <RuntimeStep config={config} complete={active.complete} onDone={advance} onSessionLost={handleSessionLost} />
        )
      case 'templates':
        return (
          <TemplatesStep
            config={config}
            complete={active.complete}
            onDone={advance}
            onSkip={() => {
              setTemplatesSkipped(true)
              goTo(activeIndex + 1)
            }}
            onSessionLost={handleSessionLost}
          />
        )
      case 'complete':
        return (
          <CompleteStep
            status={status}
            onCompleted={refresh}
            onSessionLost={handleSessionLost}
            onSelectStep={goToStepId}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {sessionNotice ? (
        <Alert
          tone="warning"
          role="alert"
          title="初始化会话已失效"
          action={
            <a href={APP_ROUTES.setup} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              重新加载
            </a>
          }
        >
          {sessionNotice}
        </Alert>
      ) : null}

      {openSetupNotice ? (
        <Alert tone="info" role="status" title="初始化期间开放配置">
          本次部署未要求领取码：初始化期间任何能访问此地址的人都可以配置，创建管理员后会自动关闭开放入口。
        </Alert>
      ) : null}

      {statusQuery.isError ? (
        <Alert tone="warning" role="status" title="状态刷新失败">
          当前显示上次读取的完成状态，请稍后刷新页面重试。
        </Alert>
      ) : null}

      {configQuery.isError && !isSetupSessionError(configQuery.error) ? (
        <Alert
          tone="warning"
          role="status"
          title="无法读取系统配置"
          action={
            <Button variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
              重试
            </Button>
          }
        >
          {describeSetupError(configQuery.error, '请稍后刷新页面后重试。')}
        </Alert>
      ) : null}

      <SetupStepProvider stepPosition={positionLabel} complete={active.complete} footer={stepFooter}>
        <div key={active.id} className="motion-page-enter">
          {renderStep()}
        </div>
      </SetupStepProvider>

      {!canAdvance && active.id !== 'complete' ? (
        <p role="status" className="text-center text-xs text-muted-foreground">
          完成本步骤的提交后才能继续。
        </p>
      ) : null}
    </div>
  )
}
