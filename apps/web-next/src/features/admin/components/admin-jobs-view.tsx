'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminJob } from '@/shared/types'
import { ArrowUpDown, Loader2, RefreshCw } from 'lucide-react'

export function AdminJobsView() {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [timeSort, setTimeSort] = useState<'desc' | 'asc'>('desc')

  const {
    data: jobs = [],
    isLoading,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['admin', 'jobs', { status: statusFilter }],
    queryFn: async () => {
      const res = await api<{ items: AdminJob[] }>(API_ENDPOINTS.admin.jobs, {
        params: {
          ...(statusFilter === 'all' ? {} : { status: statusFilter }),
          limit: 50,
        },
      })
      return res.data?.items || []
    },
  })

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

  const filterActive = statusFilter !== 'all'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">任务监控</h1>
          <p className="text-sm text-muted-foreground">全系统生成任务队列状态、错误日志与进度监控。</p>
        </div>
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-[var(--radius-control)] border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground outline-none"
          >
            <option value="all">所有状态</option>
            <option value="queued">排队中 (queued)</option>
            <option value="running">运行中 (running)</option>
            <option value="succeeded">成功 (succeeded)</option>
            <option value="failed">失败 (failed)</option>
            <option value="cancelled">已取消 (cancelled)</option>
          </select>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">任务 ID</th>
              <th className="px-4 py-3 font-medium">用户</th>
              <th className="px-4 py-3 font-medium">模型</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">耗时 / 错误</th>
              <th aria-sort={timeSort === 'desc' ? 'descending' : 'ascending'} className="px-4 py-3 text-right font-medium">
                <button
                  type="button"
                  onClick={() => setTimeSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                  className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] px-2 hover:bg-surface-subtle hover:text-foreground"
                >
                  提交时间
                  <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : sortedJobs.length > 0 ? (
              sortedJobs.map((job) => (
                <tr key={job.id} className="hover:bg-surface-subtle/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-muted-foreground">{job.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 text-foreground">{job.userEmail || job.userId?.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-medium text-foreground">{job.modelName || '未知模型'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                        job.status === 'succeeded'
                          ? 'bg-success-soft text-success'
                          : job.status === 'failed'
                            ? 'bg-danger-soft text-danger'
                            : job.status === 'running'
                              ? 'bg-accent-soft text-accent-strong'
                              : 'bg-surface-subtle text-muted-foreground'
                      }`}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {job.errorMessage ? (
                      <span className="text-danger truncate max-w-xs block" title={job.errorMessage}>
                        {job.errorMessage}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  {filterActive ? '没有符合当前筛选条件的任务，调整筛选后重试。' : '暂无任务记录。'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
