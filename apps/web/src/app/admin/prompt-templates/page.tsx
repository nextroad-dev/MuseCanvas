import type { Metadata } from 'next'
import { AdminPromptTemplatesView } from '@/features/admin/components/admin-prompt-templates-view'

export const metadata: Metadata = {
  title: '提示词模板',
  description: '管理提示词模板集的版本、条目、导入导出预览与语言模型优化设置。',
}

/** 后台提示词模板页（AdminShell 提供守卫与页面框架，页面只渲染内容）。 */
export default function AdminPromptTemplatesPage() {
  return <AdminPromptTemplatesView />
}
