import { AdminLanguageModelsView } from '@/features/admin/components/admin-language-models-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '语言模型 - MuseCanvas 管理后台',
}

export default function AdminLanguageModelsPage() {
  return <AdminLanguageModelsView />
}
