'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ArrowClockwiseIcon as RefreshCw,
  ChartBarIcon as ChartBar,
  CpuIcon as Cpu,
  ImagesIcon as Images,
  PulseIcon as Pulse,
  UsersIcon as Users,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SectionHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  iconSize,
} from '@/shared/components/ui'
import { useModels } from '@/shared/hooks/useModels'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatCount, formatDateTime } from '@/shared/lib/format'
import { jobStatusLabel, jobStatusTone } from '@/shared/lib/job-status'
import type { AdminJobDto } from '@/shared/types'
import {
  buildChartDays,
  buildChartLabel,
  formatUpdatedTime,
  jobMediaKindLabel,
  normalizeDashboardDays,
  summarizeDashboard,
  summarizeDefaultModels,
  truncateJobId,
  useAdminDashboard,
  useAdminMediaModelDefaults,
  useAdminRecentJobs,
} from '../lib/admin-query'
import type { AdminDefaultModelEntry } from '../lib/admin-query'

const RECENT_JOBS_COLUMNS = 5
const RECENT_JOBS_CAPTION = '最近 10 条生成任务'
const RECENT_JOBS_ANCHOR = '#admin-recent-jobs'

type MetricTone = 'accent' | 'info' | 'neutral' | 'success'

const METRIC_TONE_CLASS: Record<MetricTone, string> = {
  accent: 'bg-accent-soft text-accent',
  info: 'bg-info-soft text-info',
  neutral: 'bg-tonal text-foreground',
  success: 'bg-success-soft text-success',
}

/** 指标卡：Phosphor duotone 图标徽章 + 标签 + 等宽数值。 */
function MetricCard({
  label,
  value,
  icon,
  tone = 'accent',
  hint,
  loading,
}: {
  label: string
  value: string
  icon: ReactNode
  tone?: MetricTone
  hint?: ReactNode
  loading: boolean
}) {
  return (
    <Card density="none" className="justify-between gap-4 border border-border px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-ui font-medium text-muted-foreground">{label}</p>
        <span
          aria-hidden="true"
          className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-control', METRIC_TONE_CLASS[tone])}
        >
          {icon}
        </span>
      </div>
      {loading ? (
        <Skeleton className="h-9 w-24" />
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-mono text-title font-normal tabular-nums text-foreground">{value}</p>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
      )}
    </Card>
  )
}

/** 默认模型摘要条里的一项：模型名 / 未设置（warning）/ 已不可用。 */
function DefaultModelItem({ label, entry }: { label: string; entry: AdminDefaultModelEntry }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>
        {entry.state === 'ready' ? (
          <span className="text-sm font-medium text-foreground">{entry.name}</span>
        ) : entry.state === 'unset' ? (
          <Badge tone="warning">未设置</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">模型已不可用</span>
        )}
      </dd>
    </div>
  )
}

/** 最近任务一行：ID 缩写 / 类型 / 模型 / 状态 / 创建时间。 */
function RecentJobRow({ job }: { job: AdminJobDto }) {
  return (
    <TableRow>
      <TableCell mono title={job.id}>
        {truncateJobId(job.id)}
      </TableCell>
      <TableCell>{jobMediaKindLabel(job.mediaKind)}</TableCell>
      <TableCell>{job.modelName || '—'}</TableCell>
      <TableCell>
        <Badge tone={jobStatusTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
      </TableCell>
      <TableCell align="right" mono tone="muted">
        <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
      </TableCell>
    </TableRow>
  )
}

/**
 * 后台概览（画板 07）。
 *
 * 三块数据各自独立查询：仪表盘聚合 + 默认模型 + 最近任务；任一块失败只降级该块，
 * 不拖垮整页。图表柱高在 `admin-query.ts` 里算成像素，这里只负责呈现，
 * 因此 `role="img"` 的 aria-label 与视觉结论来自同一份汇总。
 */
export function AdminDashboardView() {
  const dashboardQuery = useAdminDashboard()
  const defaultsQuery = useAdminMediaModelDefaults()
  const modelsQuery = useModels()
  const jobsQuery = useAdminRecentJobs()

  const dashboard = dashboardQuery.data
  const days = normalizeDashboardDays(dashboard)
  const chartDays = buildChartDays(days)
  const summary = summarizeDashboard(dashboard, days)
  const chartLabel = buildChartLabel(days, summary)
  const updatedAt = formatUpdatedTime(dashboardQuery.dataUpdatedAt)

  const defaults = summarizeDefaultModels(
    defaultsQuery.data,
    Array.isArray(modelsQuery.data) ? modelsQuery.data : [],
  )
  const defaultsLoading = defaultsQuery.isPending || modelsQuery.isPending
  const jobs = jobsQuery.data?.items ?? []
  const statsLoading = dashboardQuery.isPending

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="系统概览"
        description="监控实例用户规模、任务执行状态与默认模型配置。"
        actions={
          <Badge tone="neutral" className="font-mono">
            更新于 {updatedAt}
          </Badge>
        }
      />

      {dashboardQuery.isError ? (
        <Alert
          tone="danger"
          title="概览数据加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void dashboardQuery.refetch()}>
              重试
            </Button>
          }
        >
          {dashboardQuery.error instanceof Error ? dashboardQuery.error.message : '网络或服务端错误。'}
        </Alert>
      ) : null}

      <section aria-label="核心指标" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="用户总数"
          value={formatCount(dashboard?.totalUsers ?? null)}
          icon={<Users size={20} weight="duotone" />}
          tone="accent"
          loading={statsLoading}
        />
        <MetricCard
          label="累计生成任务"
          value={formatCount(dashboard?.totalJobs ?? null)}
          icon={<Images size={20} weight="duotone" />}
          tone="info"
          loading={statsLoading}
        />
        <MetricCard
          label="近 7 天任务"
          value={formatCount(summary.total)}
          icon={<ChartBar size={20} weight="duotone" />}
          tone="neutral"
          hint={
            summary.failed > 0 ? (
              <a href={RECENT_JOBS_ANCHOR} className="text-danger hover:underline">
                失败 <span className="font-mono">{summary.failed}</span>
              </a>
            ) : (
              <span>无失败</span>
            )
          }
          loading={statsLoading}
        />
        <MetricCard
          label="近 7 天成功率"
          value={summary.successRateLabel}
          icon={<Pulse size={20} weight="duotone" />}
          tone="success"
          loading={statsLoading}
        />
      </section>

      <section
        aria-label="实例运行状况"
        className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      >
        <figure className="flex flex-col gap-4 rounded-card border border-border bg-surface px-6 py-5 text-foreground shadow-soft">
          <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <span className="flex flex-wrap items-baseline gap-4">
              <span className="text-compact font-medium">近 7 天生成趋势</span>
              <span className="text-ui text-muted-foreground">
                成功率 <span className="font-mono text-foreground">{summary.successRateLabel}</span>
              </span>
              {summary.failed > 0 ? (
                <a href={RECENT_JOBS_ANCHOR} className="text-ui text-danger hover:underline">
                  失败 <span className="font-mono">{summary.failed}</span> 个，查看最近任务
                </a>
              ) : (
                <span className="text-ui text-muted-foreground">
                  失败 <span className="font-mono">{summary.failed}</span> 个
                </span>
              )}
            </span>
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2.5 rounded-sm bg-chart-positive" />
                成功
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2.5 rounded-sm bg-chart-negative" />
                失败
              </span>
            </span>
          </figcaption>

          {statsLoading ? (
            <Skeleton className="h-[150px] w-full" />
          ) : dashboardQuery.isError && !dashboard ? (
            <p className="text-sm text-muted-foreground">近 7 天数据暂不可用，可在上方重试。</p>
          ) : days.length === 0 ? (
            <p className="text-sm text-muted-foreground">近 7 天暂无生成任务数据。</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex min-w-[280px] flex-col gap-2">
                <div
                  role="img"
                  aria-label={chartLabel}
                  className="grid grid-cols-7 items-end gap-1 border-b border-border sm:gap-4"
                >
                  {chartDays.map((day) => (
                    <div key={day.date} className="flex h-[150px] flex-col items-center justify-end gap-1">
                      <span className="text-caption">
                        <span className="font-mono text-muted-foreground">{day.total}</span>
                      </span>
                      <span className="flex w-full max-w-10 flex-col overflow-hidden rounded-t-[var(--space-1)]">
                        {day.failHeight > 0 ? (
                          <span
                            aria-hidden="true"
                            className="block w-full bg-chart-negative"
                            style={{ height: day.failHeight }}
                          />
                        ) : null}
                        {day.successHeight > 0 ? (
                          <span
                            aria-hidden="true"
                            className="block w-full bg-chart-positive"
                            style={{ height: day.successHeight }}
                          />
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1 sm:gap-4" aria-hidden="true">
                  {chartDays.map((day) => (
                    <span
                      key={day.date}
                      className="text-center font-mono text-xs text-muted-foreground"
                    >
                      <span className="sm:hidden">{day.shortLabel}</span>
                      <span className="hidden sm:inline">{day.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </figure>

        <section
          aria-labelledby="admin-default-models"
          className="flex flex-col justify-between gap-5 rounded-card border border-border bg-surface px-6 py-5 text-foreground shadow-soft"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"
                >
                  <Cpu size={18} weight="duotone" />
                </span>
                <h2 id="admin-default-models" className="text-compact font-medium">
                  默认模型与队列
                </h2>
              </div>
              <Badge tone={defaults.complete ? 'success' : 'warning'} dot>
                {defaults.complete ? '就绪' : '待配置'}
              </Badge>
            </div>

            {defaultsLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-5 w-40" />
              </div>
            ) : defaultsQuery.isError || modelsQuery.isError ? (
              <p className="text-sm text-muted-foreground">暂时无法读取默认模型配置。</p>
            ) : (
              <dl className="flex flex-col gap-3 rounded-control bg-canvas p-3.5">
                <DefaultModelItem label="图像模型" entry={defaults.image} />
                <DefaultModelItem label="视频模型" entry={defaults.video} />
              </dl>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button variant="secondary" size="sm" asChild>
              <Link href={APP_ROUTES.adminPromptTemplates}>提示词与助手配置</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={RECENT_JOBS_ANCHOR}>查看最近任务</a>
            </Button>
          </div>
        </section>
      </section>

      <section aria-labelledby="admin-recent-jobs" className="flex flex-col gap-3">
        <SectionHeader
          id="admin-recent-jobs"
          className="scroll-mt-20"
          title="最近任务"
          actions={
            <>
              <Badge tone="neutral">最近 10 条</Badge>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void jobsQuery.refetch()}
                loading={jobsQuery.isFetching}
                icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
              >
                刷新
              </Button>
            </>
          }
        />

        <Table caption={RECENT_JOBS_CAPTION} columns={RECENT_JOBS_COLUMNS} className="[&>table]:min-w-[720px]">
          <TableHeader>
            <TableHeadCell>任务 ID</TableHeadCell>
            <TableHeadCell>类型</TableHeadCell>
            <TableHeadCell>模型</TableHeadCell>
            <TableHeadCell>状态</TableHeadCell>
            <TableHeadCell align="right">创建时间</TableHeadCell>
          </TableHeader>
          <TableBody busy={jobsQuery.isFetching}>
            {jobsQuery.isPending ? (
              Array.from({ length: 5 }, (_, index) => (
                <TableSkeletonRow
                  key={index}
                  cells={[
                    <Skeleton key="id" className="h-4 w-20" />,
                    <Skeleton key="kind" className="h-4 w-10" />,
                    <Skeleton key="model" className="h-4 w-32" />,
                    <Skeleton key="status" className="h-5 w-16" />,
                    <Skeleton key="time" className="ml-auto h-4 w-28" />,
                  ]}
                />
              ))
            ) : jobsQuery.isError ? (
              <TableStateRow>
                <div className="flex flex-col items-center gap-2 py-8">
                  <p className="text-sm text-muted-foreground">最近任务读取失败。</p>
                  <Button variant="secondary" size="sm" onClick={() => void jobsQuery.refetch()}>
                    重试
                  </Button>
                </div>
              </TableStateRow>
            ) : jobs.length === 0 ? (
              <TableStateRow>
                <EmptyState
                  density="compact"
                  title="还没有生成任务"
                  description="用户开始创作后，最近 10 条任务会出现在这里。"
                />
              </TableStateRow>
            ) : (
              jobs.map((job) => <RecentJobRow key={job.id} job={job} />)
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}
