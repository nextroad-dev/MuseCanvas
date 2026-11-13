import type { Metadata } from 'next'
import { AdminSettingsView } from '@/features/admin/components/admin-settings-view'

export const metadata: Metadata = {
  title: '系统配置',
  description: '维护站点信息、注册模式、SMTP、对象存储与运行时限制。',
}

/** 后台系统配置页（A1 壳提供守卫与页面框架，页面只渲染内容）。 */
export default function AdminSettingsPage() {
  return <AdminSettingsView />
}
