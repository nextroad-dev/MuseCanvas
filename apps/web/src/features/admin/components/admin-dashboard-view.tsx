'use client'

import Link from 'next/link'
import { ArrowUpRightIcon as ArrowUpRight } from '@phosphor-icons/react'

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
} from '@/shared/components/ui'
import { useModels } from '@/shared/hooks/useModels'
import { APP_ROUTES } from '@/shared/lib/app-routes'
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
const FAILED_JOBS_HREF = `${APP_ROUTES.adminJobs}?status=failed`

/** 指标卡：15px 标签 + 44px mono 数值（画板 07 的两个统计卡）。 */
function MetricCard({ label, value, loading }: { label: string; value: number | null; loading: boolean }) {
  return (
    <Card density="none" className="justify-between gap-3 px-6 py-5">
      <p className="text-compact font-medium">{label}</p>
      {loading ? (
        <Skeleton className="h-[55px] w-24" />
      ) : (
        <p className="font-mono text-cta font-normal tabular-nums">{formatCount(value)}</p>
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
        actions={<span className="font-mono text-xs text-muted-foreground">更新于 {updatedAt}</span>}
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

      <section
        aria-label="实例运行状况"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]"
      >
        <MetricCard label="用户总数" value={dashboard?.totalUsers ?? null} loading={statsLoading} />
        <MetricCard label="累计生成任务" value={dashboard?.totalJobs ?? null} loading={statsLoading} />

        <figure className="flex flex-col gap-4 rounded-card bg-surface px-6 py-5 text-foreground shadow-soft sm:col-span-2 lg:col-span-1">
          <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <span className="flex flex-wrap items-baseline gap-4">
              <span className="text-compact font-medium">近 7 天生成</span>
              <span className="text-ui">
                <span className="text-muted-foreground">
                  成功率 <span className="font-mono text-foreground">{summary.successRateLabel}</span>
                </span>
              </span>
              <Link href={FAILED_JOBS_HREF} className="text-ui hover:underline">
                <span className="text-danger">
                  失败 <span className="font-mono">{summary.failed}</span> 个，查看
                </span>
              </Link>
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
      </section>

      <section
        aria-labelledby="admin-default-models"
        className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-card bg-surface px-6 py-5 text-foreground shadow-soft"
      >
        <h2 id="admin-default-models" className="text-module">
          默认模型
        </h2>
        {defaultsLoading ? (
          <Skeleton className="h-5 w-56" />
        ) : defaultsQuery.isError || modelsQuery.isError ? (
          <p className="text-sm text-muted-foreground">暂时无法读取默认模型配置。</p>
        ) : (
          <dl className="flex flex-1 flex-wrap items-baseline gap-x-8 gap-y-3">
            <DefaultModelItem label="图像" entry={defaults.image} />
            <DefaultModelItem label="视频" entry={defaults.video} />
          </dl>
        )}
        <Button variant="secondary" size="sm" className="min-h-[var(--control-compact)] px-3.5" asChild>
          <Link href={APP_ROUTES.adminMediaModels}>去设置</Link>
        </Button>
      </section>

      <section aria-labelledby="admin-recent-jobs" className="flex flex-col gap-3">
        <SectionHeader
          id="admin-recent-jobs"
          title="最近任务"
          actions={
            <Link
              href={APP_ROUTES.adminJobs}
              className="inline-flex items-center gap-1 text-ui font-medium hover:underline"
            >
              进入任务监控
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
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
