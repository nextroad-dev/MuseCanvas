'use client'

import {
  useEffect,
  useState } from 'react'
import Link from 'next/link'
import { useRouter,
  useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api, ApiError } from '@/shared/services/api'
import { isSetupStepComplete } from './setup-state'
import type {
  BootstrapCheckKey,
  OnboardingSectionKey,
  OnboardingSectionState,
  SetupStatusResponse,
  } from '@/shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  SkeletonRow,
  SkeletonText,
  Stepper,
  PageHeader,
  buttonVariants,
  iconSize,
} from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { cn } from '@/shared/lib/cn'

import { CheckIcon as Check, CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight, WarningCircleIcon as CircleAlert } from '@phosphor-icons/react'

/**
 * What the wizard can actually read from `GET /setup/status`: the persisted
 * onboarding sections and the server-side bootstrap diagnostics. Everything else
 * on these steps is a manual checklist item and is labelled as such — the guide
 * never presents reading a checklist as having run a check (components.md 反馈与状态:
 * 不把假保存、假上传包装成完成).
 */
interface WizardStep {
  id: string
  label: string
  /** Onboarding sections whose real, stored status this step reports. */
  sections: OnboardingSectionKey[]
  summary: string
  /** Manual verification items: the wizard does not check these. */
  manual: string[]
}

const steps: WizardStep[] = [
  {
    id: 'site',
    label: '站点配置',
    sections: ['site'],
    summary: '站点配置包括服务域名（例如 https://musecanvas.example.com）及公开访问端点。',
    manual: [
      '服务端环境变量 BASE_URL 已指向本实例的公开地址。',
      '站点名称与地址将用于邮件、OAuth 回调与分享链接。',
    ],
  },
  {
    id: 'smtp',
    label: 'SMTP 邮件与管理员',
    sections: ['smtp', 'admin'],
    summary: '查看 SMTP 发信服务及管理员账号的服务端记录。当前页面不会配置邮件、领取或创建管理员。',
    manual: [
      '发信测试在管理后台的系统配置页执行，向导本身不会发送任何邮件。',
      '管理员账号的创建与领取需通过独立初始化流程完成；当前页面只读取状态。',
    ],
  },
  {
    id: 'storage',
    label: '对象存储（S3）',
    sections: ['storage'],
    summary: '对象存储（S3 兼容、阿里云 OSS、腾讯云 COS、Cloudflare R2、本地 MinIO）用于持久化保存用户生成的图片资产。',
    manual: [
      '存储桶凭据在管理后台的系统配置页写入，向导不读写任何对象。',
      'Worker 会在生成完毕后把资产上传至目标存储桶并签发访问 URL。',
    ],
  },
  {
    id: 'providers',
    label: 'AI 模型与供应商',
    sections: ['providers', 'models'],
    summary: '配置上游生成大模型服务凭据（如 OpenAI DALL·E 3、火山引擎 Seedream、Anthropic Claude、Google Veo）。',
    manual: [
      '模型与凭据由管理后台配置；实际生成可能产生第三方费用。',
      '向导不请求任何上游接口，也不会校验 Key 是否可用。',
    ],
  },
  {
    id: 'review',
    label: '环境检查与完成',
    sections: ['oauth', 'templates', 'runtime'],
    summary: '汇总服务端启动时记录的环境检查结果，以及尚未完成的引导条目。',
    manual: ['下方“环境检查”来自服务端读取结果；其余条目需要你逐项人工确认。'],
  },
]

export function SetupWizardSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground" role="status" aria-busy="true">
      <span className="sr-only">正在读取系统配置状态</span>
      <header className="border-b border-border bg-surface" aria-hidden="true">
        <ContentFrame className="flex h-[var(--layout-header)] items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-6 w-24 rounded-pill" />
          </div>
        </ContentFrame>
      </header>
      <div className="shrink-0 bg-tonal py-6 sm:py-8" aria-hidden="true">
        <ContentFrame>
          <ol className="flex w-full flex-col gap-4 sm:flex-row sm:items-start sm:gap-0">
            {steps.map((step) => (
              <li key={step.id} className="relative flex min-w-0 items-center gap-3 pb-6 last:pb-0 sm:flex-1 sm:flex-col sm:items-center sm:gap-2 sm:pb-0">
                <Skeleton className="h-8 w-8 shrink-0 rounded-pill" />
                <Skeleton className="h-4 w-28 sm:max-w-full" />
              </li>
            ))}
          </ol>
        </ContentFrame>
      </div>
      <main className="flex flex-1 justify-center py-10 sm:py-14" aria-hidden="true">
        <ContentFrame className="flex justify-center">
          <div className="flex w-full max-w-form flex-col gap-6">
            <PageHeader
              aria-hidden="true"
              title={<span className="invisible">系统初始化检查</span>}
              description={<span className="invisible">这里只读取服务端记录与人工核对清单；不会写入配置、创建账号或调用模型。</span>}
              actions={<Skeleton className="h-[var(--control-md)] w-24 rounded-control" />}
            />
            <Card className="gap-6 !shadow-none">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-40" />
                <SkeletonText lines={1} />
              </div>
              <div className="flex flex-col gap-6">
                <SkeletonText lines={2} />
                <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <SkeletonText lines={1} />
                  </div>
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
                <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <SkeletonText lines={1} />
                  </div>
                  <SkeletonText lines={2} />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Skeleton className="h-[var(--control-md)] w-28 rounded-control" />
                <Skeleton className="h-[var(--control-md)] w-28 rounded-control" />
              </div>
            </Card>
          </div>
        </ContentFrame>
      </main>
    </div>
  )
}

const checkKeyLabel: Record<BootstrapCheckKey, string> = {
  database: '数据库连接',
  redis: 'Redis Streams 队列',
  masterKey: '主密钥（HKDF）',
  runtime: '运行时限制',
}

function sectionLabel(key: OnboardingSectionKey): string {
  return {
    bootstrap: '环境引导',
    site: '站点信息',
    smtp: 'SMTP 邮件',
    admin: '管理员账号',
    storage: '对象存储',
    providers: '模型供应商',
    models: '生成模型',
    oauth: 'OAuth 登录',
    templates: '提示词模板',
    runtime: '运行时限制',
  }[key]
}

function SectionStatusLine({
  sectionKey,
  state,
}: {
  sectionKey: OnboardingSectionKey
  state?: OnboardingSectionState
}) {
  const complete = state?.status === 'complete'
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className="text-sm text-foreground">{sectionLabel(sectionKey)}</span>
      <span className="flex items-center gap-2">
        {state ? (
          <span className="font-mono text-xs text-muted-foreground">{state.updatedAt.slice(0, 10)}</span>
        ) : null}
        <Badge tone={complete ? 'success' : 'neutral'}>{complete ? '服务端已记录' : state ? '尚未完成' : '未返回状态'}</Badge>
      </span>
    </div>
  )
}

/** Tonal grouping inside a card — spacing and background, never a divider rule. */
function InfoGroup({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {children}
    </div>
  )
}

function ManualList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-sm text-foreground">
          <CircleAlert weight="fill" aria-hidden="true" className={`mt-1 ${iconSize.xs} shrink-0 text-muted-foreground`} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

export function SetupWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const stepParam = searchParams.get('step') || 'site'

  const [currentStepIndex, setCurrentStepIndex] = useState(
    Math.max(0, steps.findIndex((s) => s.id === stepParam)),
  )

  const [visitedSteps, setVisitedSteps] = useState(() => new Set([stepParam]))
  const { data: status, isLoading, error, isFetching, refetch } = useQuery<SetupStatusResponse>({
    queryKey: ['setup', 'status'],
    queryFn: async () => {
      const res = await api<SetupStatusResponse>(API_ENDPOINTS.setup.status)
      if (!res.success || !res.data) throw new ApiError(res.error?.code ?? 'INVALID_RESPONSE', '无法读取初始化状态。请检查服务连接后重试。')
      return res.data
    },
    retry: false,
  })

  useEffect(() => {
    const idx = steps.findIndex((s) => s.id === stepParam)
    if (idx >= 0) {
      setCurrentStepIndex(idx)
      setVisitedSteps(previous => new Set([...previous, steps[idx].id]))
    }
  }, [stepParam])

  const currentStep = steps[currentStepIndex] || steps[0]
  const isLastStep = currentStepIndex === steps.length - 1

  function navigateToStep(idx: number) {
    if (idx >= 0 && idx < steps.length) {
      setCurrentStepIndex(idx)
      router.push(`/setup?step=${steps[idx].id}`)
    }
  }

  if (isLoading) {
    return <SetupWizardSkeleton />
  }

  const checks = status?.bootstrap?.checks ?? []
  const environmentReady = status?.bootstrap?.ready === true

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      {/* Header — a page-level rule is allowed here (this is not a card). */}
      <header className="border-b border-border bg-surface">
        <ContentFrame className="flex min-h-[var(--layout-header)] flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" aria-label="MuseCanvas 首页" className="rounded-control"><BrandMark variant="wordmark" className="h-6 w-auto" /></Link>
            <Badge tone="accent">只读检查</Badge>
          </div>
          {status?.setupComplete ? (
            <span className="text-sm text-muted-foreground">系统已完成初始配置</span>
          ) : null}
        </ContentFrame>
      </header>

      {/* Stepper: horizontal from 640px (`sm`) up, vertical below it, labels always visible. */}
      <div className="shrink-0 bg-tonal py-6 sm:py-8">
        <ContentFrame>
          <Stepper
            steps={steps.map((step) => ({
              id: step.id,
              label: step.label,
              completed: isSetupStepComplete(step.sections, status),
              visited: visitedSteps.has(step.id),
            }))}
            current={currentStepIndex}
            onStepSelect={(index) => navigateToStep(index)}
            aria-label="初始化步骤"
          />
        </ContentFrame>
      </div>

      <main className="motion-page-enter flex flex-1 justify-center py-10 sm:py-14">
        <ContentFrame className="flex justify-center">
          <div className="flex w-full max-w-form flex-col gap-6">
          <PageHeader title="系统初始化检查" description="这里只读取服务端记录与人工核对清单；不会写入配置、创建账号或调用模型。" actions={<Button variant="secondary" onClick={() => void refetch()} loading={isFetching}>刷新状态</Button>} />
          {error && <Alert tone="danger" role="alert" title={status ? '状态刷新失败' : '无法读取初始化状态'}>{status ? '仍显示上次读取的状态。请稍后刷新，不要将旧结果当作当前检查通过。' : '当前状态未知，请检查服务连接后刷新。本页不会将读取失败显示为待配置。'}</Alert>}
          <Card className="gap-6 !shadow-none">
            {/* Keyed by step: moving between steps replays the entrance on the new content only. */}
            <div key={currentStep.id} className="motion-page-enter flex flex-col gap-6">
            <CardHeader className="gap-1">
              <CardTitle level={2}>{currentStep.label}</CardTitle>
              <CardDescription>
                查看此分区的已记录状态；实际配置与完整首装流程不在本页执行。
              </CardDescription>
            </CardHeader>

            <CardBody className="gap-6">
              <p className="text-sm text-foreground">{currentStep.summary}</p>

              {status && (currentStep.id === 'review' ? (
                <InfoGroup
                  title="环境检查（服务端读取结果）"
                  caption={
                    status?.bootstrap
                      ? `由服务端在 ${status.bootstrap.checkedAt.slice(0, 10)} 读取，向导本身不执行这些检查。`
                      : '服务端未返回环境检查结果。'
                  }
                >
                  {status?.bootstrap ? (
                    <ul className="flex flex-col gap-2">
                      {checks.map((check) => {
                        const ok = check.status === 'ok'
                        return (
                          <li key={check.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                            <span className="text-sm text-foreground">{checkKeyLabel[check.key]}</span>
                            <Badge
                              tone={ok ? 'success' : check.status === 'missing' ? 'warning' : 'danger'}
                              icon={ok ? <Check weight="fill" /> : <CircleAlert weight="fill" />}
                            >
                              {ok ? '正常' : check.status === 'missing' ? '缺失' : '异常'}
                            </Badge>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <Alert tone="warning" role="status">
                      环境检查结果不可用。请确认 API 服务已启动后重新打开本页。
                    </Alert>
                  )}

                  <div className="flex flex-col gap-2">
                    {steps.flatMap((step) => step.sections).map((sectionKey) => (
                      <SectionStatusLine
                        key={sectionKey}
                        sectionKey={sectionKey}
                        state={status?.sections?.[sectionKey]}
                      />
                    ))}
                  </div>
                </InfoGroup>
              ) : (
                <InfoGroup
                  title="系统实际检查"
                  caption="以下状态由服务端引导记录读取，向导不会代为执行任何配置或请求。"
                >
                  <div className="flex flex-col gap-2">
                    {currentStep.sections.map((sectionKey) => (
                      <SectionStatusLine
                        key={sectionKey}
                        sectionKey={sectionKey}
                        state={status?.sections?.[sectionKey]}
                      />
                    ))}
                  </div>
                </InfoGroup>
              ))}

              <InfoGroup
                title="人工核对清单"
                caption="向导不会验证以下内容，请你在对应管理后台页面自行确认。"
              >
                <ManualList items={currentStep.manual} />
              </InfoGroup>

              {status && currentStep.id === 'review' ? (
                environmentReady ? (
                  <Alert tone="success" role="status" title="环境检查通过">
                    服务端记录的环境检查全部正常。仍需人工确认的条目见上方的引导记录状态与核对清单。
                  </Alert>
                ) : (
                  <Alert tone="danger" role="alert" title="环境检查尚未通过">
                    {status?.bootstrap
                      ? '至少有一项环境检查未通过，请先处理上方标记为缺失或异常的条目。'
                      : '服务端没有返回环境检查结果，因此无法确认实例是否具备运行条件。'}
                  </Alert>
                )
              ) : null}

              {currentStep.id === 'review' ? (
                <div className="flex flex-wrap gap-3">
                  <Link href="/generate" className={buttonVariants({ variant: 'primary' })}>
                    进入创作端
                  </Link>
                  <Link href="/admin" className={buttonVariants({ variant: 'secondary' })}>
                    进入管理后台
                  </Link>
                </div>
              ) : null}
            </CardBody>
            </div>

            {/* Card footer actions: spacing separates them, no rule. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => navigateToStep(currentStepIndex - 1)}
                disabled={currentStepIndex === 0}
                icon={<ChevronLeft weight="bold" aria-hidden="true" className={iconSize.sm} />}
              >
                上一步
              </Button>

              {!isLastStep ? (
                <Button
                  onClick={() => navigateToStep(currentStepIndex + 1)}
                  icon={
                    <ChevronRight weight="bold"
                      aria-hidden="true"
                      className={cn(`${iconSize.sm} order-2`)}
                    />
                  }
                >
                  下一步
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
        </ContentFrame>
      </main>
    </div>
  )
}
