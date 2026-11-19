'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ChartBarIcon,
  CpuIcon,
  GearSixIcon,
  ImagesIcon,
  ListChecksIcon,
  PulseIcon,
  PuzzlePieceIcon,
  UsersIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'

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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  controlSquare,
  iconSize,
} from '@/shared/components/ui'
import { useAdminDashboard, useAdminJobs } from '@/shared/hooks/useAdmin'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatCount, formatDateTime, formatMonthDay } from '@/shared/lib/format'
import { jobStatusLabel, jobStatusTone } from '@/shared/lib/job-status'
import type { AdminDashboardDayDto, AdminJobDto } from '@/shared/types'
import { AdminMediaModelDefaultsCard } from './admin-media-model-defaults'

const RECENT_JOBS_LIMIT = 6
const RECENT_JOBS_COLUMNS = 5
const BAR_MAX_HEIGHT_PX = 128

type MetricTone = 'accent' | 'info' | 'success' | 'danger' | 'neutral'

const METRIC_TONE_CLASS: Record<MetricTone, string> = {
  accent: 'bg-accent-soft text-accent',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-tonal text-foreground',
}

function formatSuccessRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${rounded}%`
}

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function mediaKindLabel(kind: string): string {
  if (kind === 'image') return '图像'
  if (kind === 'video') return '视频'
  return kind || '—'
}

function formatDurationMs(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return '—'
  }
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  return `${(durationMs / 1000).toFixed(1)} s`
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
  loading,
}: {
  label: string
  value: string
  hint?: ReactNode
  icon: ReactNode
  tone: MetricTone
  loading: boolean
}) {
  return (
    <Card density="none" className="justify-between gap-4 border border-border px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-ui font-medium text-muted-foreground">{label}</p>
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-control',
            controlSquare.md,
            METRIC_TONE_CLASS[tone],
          )}
        >
          {icon}
        </span>
      </div>
      {loading ? (
        <Skeleton className="h-9 w-28" />
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-mono text-title font-semibold tabular-nums text-foreground">{value}</p>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
      )}
    </Card>
  )
}

function SevenDayStackedChart({
  days,
  loading,
  error,
}: {
  days: AdminDashboardDayDto[]
  loading: boolean
  error: boolean
}) {
  const total7d = days.reduce((sum, day) => sum + (day.total || 0), 0)
  const succeeded7d = days.reduce((sum, day) => sum + (day.succeeded || 0), 0)
  const failed7d = days.reduce((sum, day) => sum + (day.failed || 0), 0)
  const maxDayTotal = Math.max(1, ...days.map((day) => day.total || 0))
  const allZero = days.length === 0 || total7d === 0

  return (
    <Card className="border border-border">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.md,
              )}
            >
              <ChartBarIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
            </span>
            <div className="flex flex-col gap-0.5">
              <CardTitle level={2}>近 7 天任务趋势</CardTitle>
              <CardDescription>
                按自然日堆叠展示生成任务分布（总计{' '}
                <span className="font-mono tabular-nums text-foreground">{formatCount(total7d)}</span>，成功{' '}
                <span className="font-mono tabular-nums text-foreground">{formatCount(succeeded7d)}</span>，失败{' '}
                <span className="font-mono tabular-nums text-foreground">{formatCount(failed7d)}</span>）。
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-positive" />
              <span>成功</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-negative" />
              <span>失败</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-xs border border-border bg-tonal" />
              <span>进行中 / 其他</span>
            </span>
          </div>
        </div>
      </CardHeader>

      <CardBody>
        {loading ? (
          <Skeleton className="h-44 w-full" />
        ) : error ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            近 7 天趋势数据暂时不可用，请点击右上角刷新重试。
          </p>
        ) : allZero ? (
          <EmptyState
            density="compact"
            title="近 7 天暂无生成任务"
            description="当用户提交图像或视频生成任务后，此处将按日展示成功与失败堆叠柱状图。"
          />
        ) : (
          <div className="overflow-x-auto">
            <div
              role="img"
              aria-label={`近 7 天每日生成任务趋势：共 ${total7d} 个任务，成功 ${succeeded7d} 个，失败 ${failed7d} 个`}
              className="grid min-w-[320px] grid-cols-7 items-end gap-2 pt-2 sm:gap-4"
            >
              {days.map((day) => {
                const total = Math.max(0, day.total || 0)
                const succeeded = Math.max(0, day.succeeded || 0)
                const failed = Math.max(0, day.failed || 0)
                const other = Math.max(0, total - succeeded - failed)

                const rawSuccessH = total > 0 ? Math.round((succeeded / maxDayTotal) * BAR_MAX_HEIGHT_PX) : 0
                const rawFailH = total > 0 ? Math.round((failed / maxDayTotal) * BAR_MAX_HEIGHT_PX) : 0
                const rawOtherH = total > 0 ? Math.round((other / maxDayTotal) * BAR_MAX_HEIGHT_PX) : 0

                const successH = succeeded > 0 ? Math.max(4, rawSuccessH) : 0
                const failH = failed > 0 ? Math.max(4, rawFailH) : 0
                const otherH = other > 0 ? Math.max(4, rawOtherH) : 0

                const dateLabel = formatMonthDay(day.date)
                const summaryTitle = `${day.date}：总计 ${total}（成功 ${succeeded} / 失败 ${failed}${
                  other > 0 ? ` / 其他 ${other}` : ''
                }）`

                return (
                  <div
                    key={day.date}
                    title={summaryTitle}
                    className="group flex flex-col items-center gap-2"
                  >
                    <span className="font-mono text-caption tabular-nums text-muted-foreground group-hover:text-foreground">
                      {total}
                    </span>
                    <div className="flex h-32 w-full max-w-11 flex-col justify-end rounded-control bg-canvas p-1">
                      {total === 0 ? (
                        <span aria-hidden="true" className="block h-0.5 w-full rounded-xs bg-border" />
                      ) : (
                        <div className="flex w-full flex-col overflow-hidden rounded-xs">
                          {otherH > 0 ? (
                            <span
                              aria-hidden="true"
                              className="block w-full bg-tonal"
                              style={{ height: `${otherH}px` }}
                            />
                          ) : null}
                          {failH > 0 ? (
                            <span
                              aria-hidden="true"
                              className="block w-full bg-chart-negative"
                              style={{ height: `${failH}px` }}
                            />
                          ) : null}
                          {successH > 0 ? (
                            <span
                              aria-hidden="true"
                              className="block w-full bg-chart-positive"
                              style={{ height: `${successH}px` }}
                            />
                          ) : null}
                        </div>
                      )}
                    </div>
                    <span className="font-mono text-caption tabular-nums text-muted-foreground">
                      {dateLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function RecentJobRow({ job }: { job: AdminJobDto }) {
  return (
    <TableRow hover>
      <TableCell mono tabular title={job.id}>
        {truncateId(job.id)}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{job.modelName || '—'}</span>
          <Badge tone="neutral">{mediaKindLabel(job.mediaKind)}</Badge>
        </div>
      </TableCell>
      <TableCell>
        <Badge tone={jobStatusTone(job.status)} dot>
          {jobStatusLabel(job.status)}
        </Badge>
      </TableCell>
      <TableCell mono tabular tone="muted">
        {formatDurationMs(job.durationMs)}
      </TableCell>
      <TableCell align="right" mono tabular tone="muted">
        <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
      </TableCell>
    </TableRow>
  )
}

const QUICK_LINKS = [
  {
    href: APP_ROUTES.adminUsers,
    label: '用户管理',
    description: '检索注册账户、启停状态与清理违规用户',
    icon: UsersIcon,
  },
  {
    href: APP_ROUTES.adminModels,
    label: '模型管理',
    description: '维护图像、视频与语言模型参数及并发配额',
    icon: CpuIcon,
  },
  {
    href: APP_ROUTES.adminPlugins,
    label: '插件管理',
    description: '校验、上传并启停第三方生成供应商插件包',
    icon: PuzzlePieceIcon,
  },
  {
    href: APP_ROUTES.adminSettings,
    label: '系统设置',
    description: '站点公开域名、SMTP 邮件、对象存储与运行时限制',
    icon: GearSixIcon,
  },
] as const

export function AdminDashboardView() {
  const dashboardQuery = useAdminDashboard()
  const recentJobsQuery = useAdminJobs({ limit: RECENT_JOBS_LIMIT })

  const dashboard = dashboardQuery.data
  const days = dashboard?.days ?? []
  const recentJobs = recentJobsQuery.data?.items ?? []
  const isRefreshing = dashboardQuery.isFetching || recentJobsQuery.isFetching

  function handleRefresh() {
    void dashboardQuery.refetch()
    void recentJobsQuery.refetch()
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="概览"
        description="查看站点运行指标、近 7 天任务趋势与默认媒体模型配置。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={isRefreshing}
            leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新数据
          </Button>
        }
      />

      {dashboardQuery.isError ? (
        <Alert
          tone="danger"
          title="概览指标加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void dashboardQuery.refetch()}>
              重试
            </Button>
          }
        >
          {dashboardQuery.error instanceof Error ? dashboardQuery.error.message : '网络或服务端错误，请稍后重试。'}
        </Alert>
      ) : null}

      {/* 4 KPI Cards */}
      <section aria-label="核心运行指标" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="总用户数"
          value={formatCount(dashboard?.totalUsers ?? null)}
          icon={<UsersIcon weight="duotone" aria-hidden="true" className={iconSize.md} />}
          tone="accent"
          loading={dashboardQuery.isPending}
          hint={
            <Link href={APP_ROUTES.adminUsers} className="text-muted-foreground transition-colors hover:text-foreground">
              管理用户 →
            </Link>
          }
        />
        <KpiCard
          label="累计任务数"
          value={formatCount(dashboard?.totalJobs ?? null)}
          icon={<ImagesIcon weight="duotone" aria-hidden="true" className={iconSize.md} />}
          tone="info"
          loading={dashboardQuery.isPending}
          hint={
            <Link href={APP_ROUTES.adminJobs} className="text-muted-foreground transition-colors hover:text-foreground">
              任务审计 →
            </Link>
          }
        />
        <KpiCard
          label="近 7 天成功率"
          value={formatSuccessRate(dashboard?.successRate7d)}
          icon={<PulseIcon weight="duotone" aria-hidden="true" className={iconSize.md} />}
          tone="success"
          loading={dashboardQuery.isPending}
        />
        <KpiCard
          label="近 7 天失败任务"
          value={formatCount(dashboard?.failedJobs7d ?? null)}
          icon={<WarningCircleIcon weight="duotone" aria-hidden="true" className={iconSize.md} />}
          tone={(dashboard?.failedJobs7d ?? 0) > 0 ? 'danger' : 'neutral'}
          loading={dashboardQuery.isPending}
          hint={
            (dashboard?.failedJobs7d ?? 0) > 0 ? (
              <Link href={APP_ROUTES.adminJobs} className="text-danger hover:underline">
                排查失败
              </Link>
            ) : (
              <span>运行正常</span>
            )
          }
        />
      </section>

      {/* 7-Day Stacked Bar Chart */}
      <SevenDayStackedChart
        days={days}
        loading={dashboardQuery.isPending}
        error={dashboardQuery.isError && !dashboard}
      />

      {/* Default Media Models Election Card */}
      <AdminMediaModelDefaultsCard />

      {/* Recent Jobs Preview Card */}
      <Card className="border border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-control bg-tonal text-foreground',
                  controlSquare.md,
                )}
              >
                <ListChecksIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
              </span>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <CardTitle level={2}>最近生成任务</CardTitle>
                  <Badge tone="neutral">最新 {RECENT_JOBS_LIMIT} 条</Badge>
                </div>
                <CardDescription>实时展示近期提交的生成任务状态与耗时。</CardDescription>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              asChild
              trailingIcon={<ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            >
              <Link href={APP_ROUTES.adminJobs}>查看全部任务</Link>
            </Button>
          </div>
        </CardHeader>

        <CardBody className="pt-0">
          <Table
            caption="最近 6 条生成任务"
            columns={RECENT_JOBS_COLUMNS}
            cardClassName="border border-border shadow-none"
            className="[&>table]:min-w-[640px]"
          >
            <TableHeader>
              <TableHeadCell>任务 ID</TableHeadCell>
              <TableHeadCell>模型 & 媒体类型</TableHeadCell>
              <TableHeadCell>状态</TableHeadCell>
              <TableHeadCell>耗时</TableHeadCell>
              <TableHeadCell align="right">创建时间</TableHeadCell>
            </TableHeader>
            <TableBody busy={recentJobsQuery.isFetching}>
              {recentJobsQuery.isPending ? (
                Array.from({ length: RECENT_JOBS_LIMIT }, (_, index) => (
                  <TableSkeletonRow
                    key={index}
                    cells={[
                      <Skeleton key="id" className="h-4 w-20" />,
                      <Skeleton key="model" className="h-4 w-36" />,
                      <Skeleton key="status" className="h-5 w-16" />,
                      <Skeleton key="duration" className="h-4 w-14" />,
                      <Skeleton key="created" className="ml-auto h-4 w-28" />,
                    ]}
                  />
                ))
              ) : recentJobsQuery.isError ? (
                <TableStateRow>
                  <div className="flex flex-col items-center gap-2 py-8">
                    <p className="text-sm text-muted-foreground">最近任务加载失败。</p>
                    <Button variant="secondary" size="sm" onClick={() => void recentJobsQuery.refetch()}>
                      重试
                    </Button>
                  </div>
                </TableStateRow>
              ) : recentJobs.length === 0 ? (
                <TableStateRow>
                  <EmptyState
                    density="compact"
                    title="暂无生成任务"
                    description="用户开始创作后，最新的生成任务会在此处列出。"
                  />
                </TableStateRow>
              ) : (
                recentJobs.map((job) => <RecentJobRow key={job.id} job={job} />)
              )}
            </TableBody>
          </Table>
        </CardBody>
      </Card>

      {/* Quick Navigation Links */}
      <section aria-label="快捷入口" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {QUICK_LINKS.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className="group flex flex-col justify-between gap-3 rounded-card border border-border bg-surface p-5 shadow-soft transition-colors hover:border-border-strong hover:bg-surface-hover"
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-control bg-tonal text-foreground transition-colors group-hover:bg-accent-soft group-hover:text-accent',
                    controlSquare.md,
                  )}
                >
                  <Icon weight="duotone" aria-hidden="true" className={iconSize.md} />
                </span>
                <ArrowRightIcon
                  weight="bold"
                  aria-hidden="true"
                  className={cn(iconSize.sm, 'text-muted-foreground transition-colors group-hover:text-foreground')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-compact font-medium text-foreground">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </div>
            </Link>
          )
        })}
      </section>
    </div>
  )
}
