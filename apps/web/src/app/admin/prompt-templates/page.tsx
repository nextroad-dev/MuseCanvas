import type { Metadata } from 'next'
import { AdminPromptTemplatesView } from '@/features/admin/components/admin-prompt-templates-view'

export const metadata: Metadata = {
  title: '提示词模板',
  description: '管理提示词模板集的版本、条目、导入导出预览与语言模型相关设置。',
}

/** 后台提示词模板页（A1 壳提供守卫与页面框架，页面只渲染内容）。 */
export default function AdminPromptTemplatesPage() {
  return <AdminPromptTemplatesView />
}
