import { AdminPromptTemplatesView } from '@/features/admin/components/admin-prompt-templates-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '提示词模板 - MuseCanvas 管理后台',
}

export default function AdminPromptTemplatesPage() {
  return <AdminPromptTemplatesView />
}
