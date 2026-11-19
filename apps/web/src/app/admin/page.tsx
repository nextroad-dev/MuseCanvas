import type { Metadata } from 'next'

import { AdminDashboardView } from '@/features/admin/components/admin-dashboard-view'

/**
 * 后台概览（`/admin`）。守卫与外壳在 `admin/layout.tsx`；
 * 本页保持 Server Component，数据由客户端岛通过 TanStack Query 拉取。
 */
export const metadata: Metadata = {
  title: '概览',
  description: '查看站点运行指标、近 7 天任务趋势与默认媒体模型配置。',
}

export default function AdminDashboardPage() {
  return <AdminDashboardView />
}
