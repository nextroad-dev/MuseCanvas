'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Alert, Badge, Button, Divider, PageHeader, Stepper, iconSize } from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight } from '@phosphor-icons/react'
import {
  canCompleteSetup,
  isSetupSessionError,
  OPEN_SETUP_NOTICE,
  parseSetupStepId,
  resolveActiveStepIndex,
  resolveCompletionChecklist,
  resolveResumeIndex,
  resolveSetupSteps,
  setupIntroDescription,
  setupStepPosition,
  shouldShowOpenSetupNotice,
} from '../lib/setup-wizard-state'
import type { SetupStepId } from '../lib/setup-wizard-state'
import {
  errorCodeOf,
  fetchSetupConfig,
  fetchSetupDatabase,
  fetchSetupStatus,
  setupQueryKeys,
} from '../lib/setup-requests'
import { SetupWizardSkeleton } from './setup-wizard-skeleton'
import { ClaimStep } from './steps/claim-step'
import { SiteStep } from './steps/site-step'
import { SmtpStep } from './steps/smtp-step'
import { AdminStep } from './steps/admin-step'
import { DatabaseStep } from './steps/database-step'
import { StorageStep } from './steps/storage-step'
import { CompleteStep } from './steps/complete-step'

/**
 * Client island for the installer. The server guard in `app/setup/layout.tsx` has
 * already decided who may be here; this component reads state only through the
 * `setup` endpoints and resumes at the first step the stored state does not complete.
 */
export function SetupWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const statusQuery = useQuery({ queryKey: setupQueryKeys.status, queryFn: fetchSetupStatus, retry: false })
  const configQuery = useQuery({ queryKey: setupQueryKeys.config, queryFn: fetchSetupConfig, retry: false })
  // The config read is guarded by the setup session, so a successful read is the claim signal.
  const claimed = configQuery.isSuccess
  const databaseQuery = useQuery({
    queryKey: setupQueryKeys.database,
    queryFn: fetchSetupDatabase,
    enabled: claimed,
    retry: false,
  })

  const status = statusQuery.data
  const config = configQuery.data
  const database = databaseQuery.data ?? config?.database
  // Absent `claimRequired` (no status yet, or an older server) keeps the claim step.
  const claimRequired = status?.claimRequired
  const steps = resolveSetupSteps({
    claimed,
    claimRequired,
    setupComplete: status?.setupComplete === true,
    sections: status?.sections,
    databaseReachable: database?.reachable === true,
  })
  const resumeIndex = resolveResumeIndex(steps)
  const checklist = resolveCompletionChecklist(status?.sections)
  const canComplete = canCompleteSetup(checklist)

  const [requestedId, setRequestedId] = useState<SetupStepId | null>(() => parseSetupStepId(searchParams.get('step')))
  const [reached, setReached] = useState(0)

  if (statusQuery.isLoading || configQuery.isLoading) {
    return <SetupWizardSkeleton />
  }

  // A deep link to a step that is not in this list (e.g. `claim` when no claim is required) resumes instead.
  const activeIndex = resolveActiveStepIndex(steps, requestedId)
  const active = steps[activeIndex] ?? steps[0]
  const furthest = Math.max(reached, resumeIndex)
  const smtpReady = steps.find((step) => step.id === 'smtp')?.complete === true
  const configErrorIsSession = configQuery.isError && isSetupSessionError(errorCodeOf(configQuery.error))
  const openSetupNotice = shouldShowOpenSetupNotice(claimRequired, activeIndex)

  function goTo(index: number) {
    const target = steps[index]
    if (!target) return
    setRequestedId(target.id)
    setReached((previous) => Math.max(previous, index))
    router.replace(`/setup?step=${target.id}`, { scroll: false })
  }

  const alerts = (
    <>
      {statusQuery.isError ? (
        status ? (
          <Alert tone="danger" role="alert" title="状态刷新失败">
            仍显示上次读取的状态。请稍后刷新，不要将旧结果当作当前检查通过。
          </Alert>
        ) : (
          <Alert
            tone="danger"
            role="alert"
            title="无法读取初始化状态"
            action={
              <Button variant="secondary" size="sm" onClick={() => void statusQuery.refetch()}>
                刷新状态
              </Button>
            }
          >
            当前状态未知，请检查服务连接后刷新。本页不会将读取失败显示为待配置。
          </Alert>
        )
      ) : null}
      {configQuery.isError && !configErrorIsSession ? (
        <Alert tone="warning" role="status" title="无法读取系统配置">
          {configQuery.error instanceof Error ? configQuery.error.message : '请稍后刷新页面后重试。'}
        </Alert>
      ) : null}
    </>
  )

  function blockedStep(): ReactNode {
    if (claimRequired !== false && (configErrorIsSession || !configQuery.isError)) {
      const claimIndex = steps.findIndex((step) => step.id === 'claim')
      return (
        <Alert
          tone="info"
          role="status"
          title="请先领取初始化码"
          action={
            <Button variant="secondary" size="sm" onClick={() => goTo(claimIndex)}>
              前往领取
            </Button>
          }
        >
          领取码验证通过后才能配置本步骤。
        </Alert>
      )
    }
    return (
      <Alert tone="warning" role="status" title="系统配置暂不可读取">
        请稍后刷新页面后重试。
      </Alert>
    )
  }

  function renderStep(): ReactNode {
    if (active.id === 'claim') return <ClaimStep claimed={claimed} />
    if (!config) return blockedStep()
    switch (active.id) {
      case 'site':
        return <SiteStep settings={config.site} complete={active.complete} />
      case 'smtp':
        return <SmtpStep settings={config.smtp} />
      case 'admin':
        return <AdminStep complete={active.complete} smtpReady={smtpReady} />
      case 'database':
        return (
          <DatabaseStep
            database={database}
            loadError={databaseQuery.isError ? '数据库状态暂不可读取。可点击“重新检测”再试一次。' : null}
          />
        )
      case 'storage':
        return <StorageStep settings={config.storage} />
      case 'complete':
        return <CompleteStep runtime={config.runtime} checklist={checklist} canComplete={canComplete} />
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      {/* Header — a page-level rule is allowed here (this is not a card). */}
      <header className="border-b border-border bg-surface">
        <ContentFrame className="flex min-h-[var(--layout-header)] flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" aria-label="MuseCanvas 首页" className="rounded-control">
              <BrandMark variant="wordmark" className="h-6 w-auto" />
            </Link>
            <Badge tone="accent">初始化向导</Badge>
          </div>
          {status?.setupComplete ? <span className="text-sm text-muted-foreground">系统已完成初始配置</span> : null}
        </ContentFrame>
      </header>

      {/* Stepper: horizontal from 640px (`sm`) up, vertical below it, labels always visible. */}
      <div className="shrink-0 bg-tonal py-6 sm:py-8">
        <ContentFrame>
          <Stepper
            steps={steps.map((step, index) => ({
              id: step.id,
              label: step.label,
              completed: step.complete,
              visited: index <= furthest,
            }))}
            current={activeIndex}
            onStepSelect={(index) => goTo(index)}
            aria-label="初始化步骤"
          />
        </ContentFrame>
      </div>

      <main className="motion-page-enter flex flex-1 justify-center py-10 sm:py-14">
        <ContentFrame className="flex justify-center">
          <div className="flex w-full max-w-form flex-col gap-8">
            <PageHeader
              title="系统初始化"
              description={setupIntroDescription(claimRequired)}
            />
            {alerts}

            {/* Keyed by step: moving between steps replays the entrance on the new content only. */}
            <div key={active.id} className="motion-page-enter flex flex-col gap-8">
              {openSetupNotice ? <Alert tone="info" title="初始化期间开放配置">{OPEN_SETUP_NOTICE}</Alert> : null}
              {renderStep()}
            </div>

            <Divider />
            <nav aria-label="步骤导航" className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => goTo(activeIndex - 1)}
                disabled={activeIndex === 0}
                icon={<ChevronLeft weight="bold" aria-hidden="true" className={iconSize.sm} />}
              >
                上一步
              </Button>
              <span className="text-sm text-muted-foreground">{setupStepPosition(steps, activeIndex)}</span>
              {activeIndex < steps.length - 1 ? (
                <Button
                  onClick={() => goTo(activeIndex + 1)}
                  icon={<ChevronRight weight="bold" aria-hidden="true" className={iconSize.sm} />}
                >
                  下一步
                </Button>
              ) : null}
            </nav>
          </div>
        </ContentFrame>
      </main>
    </div>
  )
}
