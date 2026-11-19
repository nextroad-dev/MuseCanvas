import type { Metadata } from 'next'

import { AdminPluginsView } from '@/features/admin/components/admin-plugins-view'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '插件管理',
  description: '上传并校验 ZIP 格式模型插件包，查看安全扫描报告、文档与启停状态。',
}

export default function AdminPluginsPage() {
  return <AdminPluginsView />
}
