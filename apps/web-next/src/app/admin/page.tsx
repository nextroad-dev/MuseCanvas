import { API_ENDPOINTS } from '@musecanvas/contracts'
import { serverApi } from '@/shared/services/server-api'
import { AdminDashboardView } from '@/features/admin/components/admin-dashboard-view'
import type { AdminJob } from '@/shared/types'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '系统概览 - MuseCanvas 管理后台',
}

interface DashboardMetrics {
  totalUsers: number
  totalJobs: number
  successRate7d: number
  failedJobs7d: number
}

export default async function AdminDashboardPage() {
  const [metricsRes, jobsRes] = await Promise.all([
    serverApi.get<DashboardMetrics>(API_ENDPOINTS.admin.dashboard),
    serverApi.get<{ items: AdminJob[] }>(API_ENDPOINTS.admin.jobs, { params: { limit: '10' } }),
  ])

  const initialMetrics = metricsRes.success ? metricsRes.data : null
  const initialJobs = jobsRes.success && jobsRes.data?.items ? jobsRes.data.items : []

  return (
    <AdminDashboardView
      initialMetrics={initialMetrics}
      initialJobs={initialJobs}
    />
  )
}
