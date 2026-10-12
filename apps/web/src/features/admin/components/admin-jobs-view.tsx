'use client'

import { adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminJob, JobStatus, PaginatedResponse } from '@/shared/types'
import { adminJobErrorSummary, requireAdminData } from '../lib/admin-query'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminMobileRecords, AdminRecordDetailDialog } from './admin-record-detail-dialog'
import { AdminJobDetail } from './admin-job-detail'
import { AdminCursorControls, useAdminCursor } from './admin-cursor-controls'
import { AdminListToolbar } from './admin-list-toolbar'
import { EMPTY_ADMIN_JOB_FILTERS, readAdminJobFilters, resolveAdminJobFilters } from '../lib/admin-list-state'
import type { AdminJobFilters } from '../lib/admin-list-state'
import { ADMIN_JOB_REFRESH_MS, shouldPollAdminJobs } from '../lib/admin-job-refresh'
import { formatLocalizedDateTime } from '@/shared/lib/format'
import { jobStatusMeta } from '@/shared/lib/job-status'
import { ArrowsDownUpIcon as ArrowUpDown, ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Select,
  SkeletonText,
  TableBody,
  TableHead,
  TableHeadCell,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  TableCell,
} from '@/shared/components/ui'

/** Each cursor request fetches at most this many jobs, newest-first server-side. */
const JOB_PAGE_LIMIT = 50

/** Values accepted by `GET /api/admin/jobs?status=`; labels ride `jobStatusMeta`. */
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '所有状态' },
  ...(
    ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled'] as JobStatus[]
  ).map((status) => ({ value: status, label: jobStatusMeta(status).label })),
]

export function AdminJobsView() {
  const searchParams = useSearchParams()
  const initialFilters = readAdminJobFilters(searchParams)
  const [draftFilters, setDraftFilters] = useState<AdminJobFilters>(() => initialFilters.draft)
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>(() => initialFilters.valid ? initialFilters.params : {})
  const [filterErrors, setFilterErrors] = useState<Partial<Record<keyof AdminJobFilters, string>>>(() => initialFilters.errors)
  const [urlFilterError, setUrlFilterError] = useState(!initialFilters.valid)
  const jobCursor = useAdminCursor()
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [documentVisible, setDocumentVisible] = useState(true)
  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState === 'visible')
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  useEffect(() => {
    if (jobCursor.batch > 1) setAutoRefresh(false)
  }, [jobCursor.batch])
  const polling = shouldPollAdminJobs(autoRefresh, documentVisible, jobCursor.batch)
  const requestParams = { ...appliedFilters, limit: JOB_PAGE_LIMIT, cursor: jobCursor.cursor }

  function applyFilters(draft: AdminJobFilters) {
    const resolved = resolveAdminJobFilters(draft)
    setFilterErrors(resolved.errors)
    if (!resolved.valid) return
    setUrlFilterError(false)
    setAppliedFilters(resolved.params)
    jobCursor.reset()
  }
  function editFilter(key: keyof AdminJobFilters, value: string) {
    setDraftFilters((previous) => ({ ...previous, [key]: value }))
    setFilterErrors((previous) => ({ ...previous, [key]: undefined }))
  }
  const [detailJob, setDetailJob] = useState<AdminJob | null>(null)
  const [timeSort, setTimeSort] = useState<'desc' | 'asc'>('desc')

  const {
    data: jobsPage,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['admin', 'jobs', requestParams],
    refetchInterval: polling ? ADMIN_JOB_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    // Focus must not silently refresh a paused or historical batch.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const res = await api<PaginatedResponse<AdminJob>>(API_ENDPOINTS.admin.jobs, {
        params: requestParams,
      })
      return requireAdminData(res, '加载任务列表失败')
    },
  })

  const jobs = jobsPage?.items ?? []

  // Client-side sort over the fetched page: the monitor's natural order is
  // newest-first, flipping stays cheap and keeps the filter server-driven.
  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        return timeSort === 'desc' ? -delta : delta
      }),
    [jobs, timeSort],
  )

  const filterActive = Object.keys(appliedFilters).length > 0
  const clearFilter = () => { setDraftFilters(EMPTY_ADMIN_JOB_FILTERS); applyFilters(EMPTY_ADMIN_JOB_FILTERS) }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="任务监控"
        description="全系统生成任务状态与已有错误摘要；不提供未经接口支持的进度百分比。"
        actions={
          <>
          <Button variant="secondary" disabled={jobCursor.batch > 1} onClick={() => setAutoRefresh((previous) => !previous)}>
            {autoRefresh ? '暂停自动刷新' : '启用 15 秒刷新'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => refetch()}
            loading={isFetching}
            icon={<RefreshCw weight="bold" aria-hidden="true" />}
          >
            {error ? '重试刷新' : '手动刷新'}
          </Button>
          </>
        }
      />

      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <p>{jobCursor.batch > 1 ? '浏览历史批次：自动刷新已暂停，返回首批后可手动启用。' : !autoRefresh ? '自动刷新已暂停。' : !documentVisible ? '后台标签页：自动刷新已暂停。' : '前台标签页每 15 秒刷新当前首批。'}</p>
        <p>最近成功更新：{dataUpdatedAt ? formatLocalizedDateTime(new Date(dataUpdatedAt).toISOString()) : '尚未成功获取数据'}</p>
      </div>

      {urlFilterError && <Alert tone="warning" role="status" title="链接筛选未应用">链接中的 ID、状态或时间格式无效。当前显示未筛选首批；请打开筛选并修正后应用。</Alert>}

      <AdminListToolbar title="任务列表" description="编辑条件后点击应用；排序仅作用于当前批次。"
        summary={`第 ${jobCursor.batch} 批 · 已载入 ${jobs.length} 条`}
        activeCount={Object.keys(appliedFilters).length}
        appliedSummary={Object.entries(appliedFilters).map(([key, value]) => `${({ status: '状态', userId: '用户 ID', modelId: '模型 ID', from: '从', to: '至' } as Record<string, string>)[key]} ${key === 'status' ? STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value : value}`).join(' · ')}
        onSubmit={(event) => { event.preventDefault(); applyFilters(draftFilters) }}
        filters={<>
          <FormField label="任务状态" error={filterErrors.status} className="min-w-0">
            <Select value={draftFilters.status} onChange={(event) => editFilter('status', event.target.value)}>
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </FormField>
          <FormField label="用户 ID" error={filterErrors.userId} hint="完整 UUID，匹配创建者。" className="min-w-0">
            <Input value={draftFilters.userId} onChange={(event) => editFilter('userId', event.target.value)} placeholder="用户 UUID" />
          </FormField>
          <FormField label="模型 ID" error={filterErrors.modelId} hint="完整 UUID，不是供应商模型名称。" className="min-w-0">
            <Input value={draftFilters.modelId} onChange={(event) => editFilter('modelId', event.target.value)} placeholder="模型配置 UUID" />
          </FormField>
          <FormField label="提交时间从" error={filterErrors.from} hint="本地时间，包含起始时间。" className="min-w-0">
            <Input type="datetime-local" value={draftFilters.from} onChange={(event) => editFilter('from', event.target.value)} />
          </FormField>
          <FormField label="提交时间至" error={filterErrors.to} hint="本地时间，包含结束时间。" className="min-w-0">
            <Input type="datetime-local" value={draftFilters.to} onChange={(event) => editFilter('to', event.target.value)} />
          </FormField>
        </>}
        filterActions={<><Button type="submit">应用筛选</Button><Button variant="ghost" onClick={clearFilter}>清除筛选</Button></>}
      />

      {jobsPage && <AdminQueryFeedback error={error} hasData label="任务列表" onRetry={() => refetch()} />}

      <Button variant="secondary" className="self-start @min-[800px]/admin:hidden" onClick={() => setTimeSort((previous) => previous === 'desc' ? 'asc' : 'desc')}>
        提交时间：{timeSort === 'desc' ? '倒序' : '正序'}（当前批次）
      </Button>
      <AdminMobileRecords
        records={sortedJobs} loading={isLoading}
        error={isError && !jobsPage ? error?.message || '加载任务失败' : null}
        onRetry={() => { void refetch() }} empty={filterActive ? '当前筛选没有匹配任务，可调整上方条件。' : '用户发起生成后，任务会显示在这里。'}
        emptyVariant={filterActive ? 'no-results' : 'first-use'} emptyTitle={filterActive ? '没有匹配任务' : '还没有生成任务'}
        emptyAction={filterActive && <Button variant="secondary" onClick={clearFilter}>清除筛选</Button>}
        title={(job) => job.modelName || '未知模型'}
        status={(job) => <Badge className={jobStatusMeta(job.status).badge}>{jobStatusMeta(job.status).label}</Badge>}
        summary={(job) => <><span className="font-mono">{job.id.slice(0, 8)}…</span> · {formatLocalizedDateTime(job.createdAt)}</>}
        onDetails={setDetailJob}
      />

      <DataTable cardClassName="hidden @min-[800px]/admin:block" caption="任务监控列表" columns={6}>
        <TableHead>
          <TableHeadCell>任务 ID</TableHeadCell>
          <TableHeadCell>用户</TableHeadCell>
          <TableHeadCell>模型</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell>错误信息</TableHeadCell>
          <TableHeadCell
            align="right"
            sort={timeSort === 'desc' ? 'descending' : 'ascending'}
          >
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 text-inherit"
              onClick={() => setTimeSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              icon={<ArrowUpDown weight="bold" aria-hidden="true" />}
            >
              提交时间（当前批次）
            </Button>
          </TableHeadCell>
        </TableHead>
        <TableBody busy={isLoading}>
          {isLoading ? (
            Array.from({ length: 6 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <SkeletonText key="id" width="7rem" />,
                  <SkeletonText key="user" width="9rem" />,
                  <SkeletonText key="model" width="8rem" />,
                  <SkeletonText key="status" width="5rem" />,
                  <SkeletonText key="error" width="10rem" />,
                  { align: 'right', content: <SkeletonText width="8rem" className="ml-auto" /> },
                ]}
              />
            ))
          ) : isError && !jobsPage ? (
            <TableStateRow>
              <EmptyState
                variant="error"
                objectName="任务列表"
                title="无法加载任务列表"
                description="请求任务数据时出现问题，可能是服务暂时不可用。请稍后重试，或检查后端服务状态。"
                actionLabel="刷新重试"
                onAction={() => refetch()}
              />
            </TableStateRow>
          ) : sortedJobs.length > 0 ? (
            sortedJobs.map((job) => {
              const status = jobStatusMeta(job.status)
              const errorSummary = adminJobErrorSummary(job)
              return (
                <TableRow key={job.id}>
                  <TableCell mono tone="muted"><Button variant="ghost" size="sm" onClick={() => setDetailJob(job)} aria-label={`查看任务 ${job.id} 详情`}>{job.id.slice(0, 8)}…</Button></TableCell>
                  <TableCell tone="foreground">{job.createdBy || '—'}</TableCell>
                  <TableCell tone="strong">{job.modelName || '未知模型'}</TableCell>
                  <TableCell>
                    {/* Colour + the state in words: never colour alone. */}
                    <Badge className={status.badge}>{status.label}</Badge>
                  </TableCell>
                  <TableCell tone="muted">
                    {errorSummary ? (
                      <span className="block max-w-60 break-words text-danger">
                        {errorSummary}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell align="right" mono tabular tone="muted">
                    {formatLocalizedDateTime(job.createdAt)}
                  </TableCell>
                </TableRow>
              )
            })
          ) : filterActive ? (
            <TableStateRow>
              <EmptyState
                variant="no-results"
                objectName="任务"
                density="compact"
                onAction={clearFilter}
              />
            </TableStateRow>
          ) : (
            <TableStateRow>
              <EmptyState
                variant="first-use"
                objectName="生成任务"
                density="compact"
                title="还没有生成任务"
                description="用户发起生成后，任务会按时间倒序出现在这里。"
              />
            </TableStateRow>
          )}
        </TableBody>
      </DataTable>

      <AdminRecordDetailDialog open={detailJob !== null} onClose={() => setDetailJob(null)} title="任务详情">
        {detailJob && <>
          <p className="text-xs text-muted-foreground">详情为打开时的记录快照；自动刷新不替换弹层内容。关闭后重新打开可查看列表中的最新记录。</p>
          <AdminJobDetail job={detailJob} />
        </>}
      </AdminRecordDetailDialog>

      <AdminCursorControls batch={jobCursor.batch} count={jobs.length} total={jobsPage?.total}
        hasMore={!isError && jobsPage?.hasMore} nextCursor={jobsPage?.nextCursor} busy={isFetching}
        onPrevious={() => { if (!isFetching) jobCursor.previous() }} onNext={() => { if (!isFetching && !isError) jobCursor.next(jobsPage?.nextCursor) }} />
      <p className="text-sm text-muted-foreground">每批最多 {JOB_PAGE_LIMIT} 条；提交时间排序仅影响当前批次，批次顺序始终由服务端按新到旧提供。</p>
    </div>
  )
}
