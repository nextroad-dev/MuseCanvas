import type { Metadata } from 'next'

import { AdminDashboardView } from '@/features/admin/components/admin-dashboard-view'

/**
 * 后台概览（画板 07）。守卫与外壳在 `admin/layout.tsx`；
 * 本页保持 Server Component，数据由客户端岛用 TanStack Query 拉取。
 */
export const metadata: Metadata = {
  title: '系统概览',
  description: 'MuseCanvas 管理后台概览：用户、生成任务、近 7 天趋势与默认模型。',
}

export default function AdminDashboardPage() {
  return <AdminDashboardView />
}
