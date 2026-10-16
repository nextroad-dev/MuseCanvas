'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import Link from 'next/link'
import { api } from '@/shared/services/api'
import type { AdminJob } from '@/shared/types'
import { requireAdminData } from '../lib/admin-query'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminDefaultModelsCard } from './admin-default-models-card'
import { AdminListToolbar } from './admin-list-toolbar'
import { AdminMobileRecords, AdminRecordDetailDialog } from './admin-record-detail-dialog'
import { AdminJobDetail } from './admin-job-detail'
import { formatLocalizedDateTime } from '@/shared/lib/format'
import { jobStatusMeta } from '@/shared/lib/job-status'
import { adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  PageHeader,
  SectionHeader,
  Skeleton,
  SkeletonText,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  buttonVariants,
} from '@/shared/components/ui'

interface DashboardMetrics {
  totalUsers: number
  totalJobs: number
  successRate7d: number
  failedJobs7d: number
}

interface AdminDashboardViewProps {
  initialMetrics?: DashboardMetrics | null
  initialJobs?: AdminJob[]
}

const RECENT_JOB_LIMIT = 10

const MEDIA_KIND_LABEL: Record<string, string> = {
  image: '图像',
  video: '视频',
}

/** Backend guarantees `media_kind`; unknown values read as image, never blank. */
function adminJobMediaKind(job: AdminJob): 'image' | 'video' {
  return job.mediaKind === 'video' ? 'video' : 'image'
}

/** Title-area freshness stamp, `更新于 HH:mm` in mono. */
function formatUpdatedAt(value: number): string {
  if (!value) return ''
  const date = new Date(value)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `更新于 ${hours}:${minutes}`
}

export function AdminDashboardView({ initialMetrics, initialJobs = [] }: AdminDashboardViewProps) {
  const [detailJob, setDetailJob] = useState<AdminJob | null>(null)
  const {
    data: metrics,
    refetch: refetchMetrics,
    isFetching: isFetchingMetrics,
    isError: isMetricsError,
    error: metricsError,
    dataUpdatedAt: metricsUpdatedAt,
  } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: async () => {
      const res = await api<DashboardMetrics>(API_ENDPOINTS.admin.dashboard)
      return requireAdminData(res, '加载汇总指标失败')
    },
    initialData: initialMetrics ?? undefined,
  })

  const {
    data: jobs,
    refetch: refetchJobs,
    isFetching: isFetchingJobs,
    isLoading: jobsLoading,
    isError: isJobsError,
    error: jobsError,
    dataUpdatedAt: jobsUpdatedAt,
  } = useQuery({
    queryKey: ['admin', 'jobs', { limit: RECENT_JOB_LIMIT }],
    queryFn: async () => {
      const res = await api<{ items: AdminJob[] }>(API_ENDPOINTS.admin.jobs, {
        params: { limit: RECENT_JOB_LIMIT },
      })
      return requireAdminData(res, '加载最近任务失败').items
    },
    initialData: initialJobs.length ? initialJobs : undefined,
  })

  const refreshing = isFetchingMetrics || isFetchingJobs
  // Skeleton only while there is nothing to show; a background refresh must not
  // wipe the numbers the reader is looking at.
  const metricsPending = metrics == null && isFetchingMetrics
  const jobsPending = jobsLoading
  const updatedLabel = formatUpdatedAt(Math.max(metricsUpdatedAt ?? 0, jobsUpdatedAt ?? 0))

  const successRate = metrics?.successRate7d
  const successPct =
    typeof successRate === 'number' && Number.isFinite(successRate)
      ? Math.min(100, Math.max(0, successRate))
      : 0
  const failedCount = metrics?.failedJobs7d ?? '—'

  function handleRefresh() {
    refetchMetrics()
    refetchJobs()
  }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="系统概览"
        description="查看系统汇总指标和最近任务状态。"
        actions={
          <>
            {updatedLabel ? (
              <span className="font-mono text-xs text-muted-foreground">{updatedLabel}</span>
            ) : null}
            <Button
              variant="secondary"
              loading={refreshing}
              onClick={handleRefresh}
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
            >
              刷新数据
            </Button>
          </>
        }
      />

      {isMetricsError ? (
        <Alert
          tone="danger"
          title={metrics ? '汇总指标刷新失败' : '无法加载汇总指标'}
          action={
            <Button variant="secondary" size="sm" onClick={() => refetchMetrics()}>
              刷新重试
            </Button>
          }
        >
          {metricsError?.message ? `${metricsError.message}。` : '服务未返回统计数据。'}
          {metrics ? '仍显示上次成功的数据，可能已过时。' : '请检查网络连接，或稍后重试。'}
        </Alert>
      ) : null}

      <section aria-labelledby="dashboard-metrics-heading" className="flex min-w-0 flex-col gap-4">
        <SectionHeader
          id="dashboard-metrics-heading"
          title="实例运行状况"
          description="累计规模与近 7 天的生成结果；刷新失败时保留最近成功的数据。"
        />
        {/* Four standalone cards; the data fades in without waiting for a skeleton. */}
        <div
          key={metricsPending ? 'loading' : 'ready'}
          className="grid grid-cols-1 gap-4 motion-fade-in @min-[480px]/admin:grid-cols-2 @min-[1040px]/admin:grid-cols-4"
        >
          <Card className="min-w-0 justify-between p-5" aria-busy={metricsPending || undefined}>
            <CardHeader>
              <p className="text-sm font-medium text-muted-foreground">用户总数</p>
              {metricsPending ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                  <Skeleton className="h-10 w-28" />
                  <Skeleton className="h-4 w-36" />
                </div>
              ) : (
                <>
                  <p className="flex items-baseline gap-1">
                    <span className="text-title font-mono tabular-nums">{metrics?.totalUsers ?? '—'}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">累计注册用户</p>
                </>
              )}
            </CardHeader>
          </Card>
          <Card className="min-w-0 justify-between p-5" aria-busy={metricsPending || undefined}>
            <CardHeader>
              <p className="text-sm font-medium text-muted-foreground">任务总数</p>
              {metricsPending ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                  <Skeleton className="h-10 w-28" />
                  <Skeleton className="h-4 w-36" />
                </div>
              ) : (
                <>
                  <p className="flex items-baseline gap-1">
                    <span className="text-title font-mono tabular-nums">{metrics?.totalJobs ?? '—'}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">累计生成任务</p>
                </>
              )}
            </CardHeader>
          </Card>
          <Card className="min-w-0 justify-between p-5" aria-busy={metricsPending || undefined}>
            <CardHeader>
              <p className="text-sm font-medium text-muted-foreground">7 天成功率</p>
              {metricsPending ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                  <Skeleton className="h-10 w-28" />
                  <Skeleton className="h-4 w-36" />
                </div>
              ) : (
                <>
                  <p className="flex items-baseline gap-1">
                    <span className="text-title font-mono tabular-nums">
                      {successRate != null ? `${successRate}%` : '—'}
                    </span>
                  </p>
                  <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-pill bg-tonal">
                    <div className="h-full rounded-pill bg-success" style={{ width: `${successPct}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">近 7 天生成成功比例</p>
                </>
              )}
            </CardHeader>
          </Card>
          <Link
            href="/admin/jobs?status=failed"
            aria-label={typeof failedCount === 'number' ? `7 天失败任务 ${failedCount}，查看失败任务` : '7 天失败任务，查看失败任务'}
            className="min-w-0 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Card interactive className="h-full min-w-0 justify-between p-5" aria-busy={metricsPending || undefined}>
              <CardHeader>
                <p className="text-sm font-medium text-muted-foreground">7 天失败任务</p>
                {metricsPending ? (
                  <div className="flex flex-col gap-2" aria-hidden="true">
                    <Skeleton className="h-10 w-28" />
                    <Skeleton className="h-4 w-36" />
                  </div>
                ) : (
                  <>
                    <p className="flex items-baseline gap-1">
                      <span className="text-title font-mono tabular-nums text-danger">{failedCount}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      近 7 天失败的任务 · <span className="underline underline-offset-4">查看失败任务</span>
                    </p>
                  </>
                )}
              </CardHeader>
            </Card>
          </Link>
        </div>
      </section>

      <AdminDefaultModelsCard />

      {/* Recent jobs */}
      <section className="flex flex-col gap-4">
        <AdminListToolbar title="最近任务" description="最近 10 条生成记录，打开详情查看安全摘要。" summary={`已载入 ${jobs?.length ?? 0} 条`}
          actions={<Link href="/admin/jobs" className={buttonVariants({ variant: 'secondary' })}>进入任务监控</Link>} />
        {jobs !== undefined && <AdminQueryFeedback error={jobsError} hasData label="最近任务" onRetry={() => refetchJobs()} />}
        <AdminMobileRecords
          records={jobs ?? []} loading={jobsPending}
          error={isJobsError && jobs === undefined ? jobsError?.message || '加载最近任务失败' : null}
          onRetry={() => { void refetchJobs() }} empty={<>用户开始创作后，最近的任务会出现在这里。<Link href="/admin/jobs" className={buttonVariants({ variant: 'secondary' })}>查看全部任务</Link></>}
          title={(job) => job.modelName || '未知模型'}
          status={(job) => <Badge className={jobStatusMeta(job.status).badge}>{jobStatusMeta(job.status).label}</Badge>}
          summary={(job) => <><span>{MEDIA_KIND_LABEL[adminJobMediaKind(job)]}</span> · <span className="font-mono">{job.id.slice(0, 8)}…</span> · {formatLocalizedDateTime(job.createdAt)}</>}
          onDetails={setDetailJob}
        />
        <DataTable cardClassName="hidden @min-[800px]/admin:block" caption={`最近 ${RECENT_JOB_LIMIT} 条生成任务`} columns={5}>
          <TableHead>
            <TableHeadCell>任务 ID</TableHeadCell>
            <TableHeadCell>类型</TableHeadCell>
            <TableHeadCell>模型</TableHeadCell>
            <TableHeadCell>状态</TableHeadCell>
            <TableHeadCell align="right">创建时间</TableHeadCell>
          </TableHead>
          <TableBody busy={jobsPending}>
            {jobsPending ? (
              Array.from({ length: 5 }, (_, index) => (
                <TableSkeletonRow
                  key={index}
                  cells={[
                    <SkeletonText key="id" width="7rem" />,
                    <SkeletonText key="kind" width="4rem" />,
                    <SkeletonText key="model" width="9rem" />,
                    <SkeletonText key="status" width="5rem" />,
                    { align: 'right', content: <SkeletonText width="8rem" className="ml-auto" /> },
                  ]}
                />
              ))
            ) : isJobsError && jobs === undefined ? (
              <TableStateRow>
                <EmptyState
                  variant="error"
                  objectName="最近任务"
                  density="compact"
                  actionLabel="刷新重试"
                  onAction={() => refetchJobs()}
                />
              </TableStateRow>
            ) : jobs && jobs.length > 0 ? (
              jobs.map((job) => {
                const status = jobStatusMeta(job.status)
                return (
                  <TableRow key={job.id}>
                    <TableCell mono tone="muted"><Button variant="ghost" size="sm" onClick={() => setDetailJob(job)} aria-label={`查看任务 ${job.id} 详情`}>{job.id.slice(0, 8)}…</Button></TableCell>
                    <TableCell tone="foreground">
                      {MEDIA_KIND_LABEL[adminJobMediaKind(job)]}
                    </TableCell>
                    <TableCell tone="strong">
                      {job.modelName || '未知模型'}
                    </TableCell>
                    <TableCell>
                      <Badge className={status.badge}>{status.label}</Badge>
                    </TableCell>
                    <TableCell align="right" mono tabular tone="muted">
                      {formatLocalizedDateTime(job.createdAt)}
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableStateRow>
                <EmptyState
                  variant="first-use"
                  objectName="生成任务"
                  density="compact"
                  title="还没有生成任务"
                  description="用户开始创作后，最近的任务会出现在这里。"
                  action={
                    <Link href="/admin/jobs" className={buttonVariants({ variant: 'secondary' })}>
                      查看全部任务
                    </Link>
                  }
                />
              </TableStateRow>
            )}
          </TableBody>
        </DataTable>
        <AdminRecordDetailDialog open={detailJob !== null} onClose={() => setDetailJob(null)} title="最近任务详情">
          {detailJob && <AdminJobDetail job={detailJob} />}
        </AdminRecordDetailDialog>
      </section>
    </div>
  )
}
