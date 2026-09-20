import { AdminSettingsView } from '@/features/admin/components/admin-settings-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '系统配置 - MuseCanvas 管理后台',
}

export default function AdminSettingsPage() {
  return <AdminSettingsView />
}
