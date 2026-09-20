'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { AdminJob } from '@/shared/types'
import { Loader2, RefreshCw } from 'lucide-react'

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

export function AdminDashboardView({ initialMetrics, initialJobs = [] }: AdminDashboardViewProps) {
  const {
    data: metrics,
    refetch: refetchMetrics,
    isFetching: isFetchingMetrics,
  } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: async () => {
      const res = await api<DashboardMetrics>('/api/admin/dashboard')
      return res.data || null
    },
    initialData: initialMetrics,
  })

  const {
    data: jobs,
    refetch: refetchJobs,
    isFetching: isFetchingJobs,
  } = useQuery({
    queryKey: ['admin', 'jobs', { limit: 10 }],
    queryFn: async () => {
      const res = await api<{ items: AdminJob[] }>('/api/admin/jobs?limit=10')
      return res.data?.items || []
    },
    initialData: initialJobs,
  })

  const refreshing = isFetchingMetrics || isFetchingJobs

  function handleRefresh() {
    refetchMetrics()
    refetchJobs()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">系统概览</h1>
          <p className="text-sm text-muted-foreground">查看系统汇总指标和最近任务状态。</p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          刷新数据
        </button>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs text-muted-foreground">用户总数</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {metrics?.totalUsers ?? '—'}
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs text-muted-foreground">任务总数</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {metrics?.totalJobs ?? '—'}
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs text-muted-foreground">7天成功率</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-success">
            {metrics?.successRate7d != null ? `${metrics.successRate7d}%` : '—'}
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs text-muted-foreground">7天失败任务</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-danger">
            {metrics?.failedJobs7d ?? '—'}
          </p>
        </div>
      </div>

      {/* Recent Jobs Table */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">最近任务</h2>
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">任务 ID</th>
                <th className="px-4 py-3 font-medium">模型</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs && jobs.length > 0 ? (
                jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-muted-foreground">{job.id.slice(0, 8)}...</td>
                    <td className="px-4 py-3 text-foreground font-medium">{job.modelName || '未知模型'}</td>
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
                    <td className="px-4 py-3 font-mono text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString('zh-CN')}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-muted-foreground">
                    暂无任务数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
