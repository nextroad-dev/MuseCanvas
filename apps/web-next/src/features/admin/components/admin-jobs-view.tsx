'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { AdminJob } from '@/shared/types'
import { Loader2, RefreshCw } from 'lucide-react'

export function AdminJobsView() {
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const {
    data: jobs = [],
    isLoading,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['admin', 'jobs', { status: statusFilter }],
    queryFn: async () => {
      const url =
        statusFilter === 'all'
          ? '/api/admin/jobs?limit=50'
          : `/api/admin/jobs?status=${statusFilter}&limit=50`
      const res = await api<{ items: AdminJob[] }>(url)
      return res.data?.items || []
    },
  })

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
              <th className="px-4 py-3 font-medium">提交时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : jobs.length > 0 ? (
              jobs.map((job) => (
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
                              ? 'bg-accent-soft text-accent'
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
                  <td className="px-4 py-3 font-mono text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  暂无匹配任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
