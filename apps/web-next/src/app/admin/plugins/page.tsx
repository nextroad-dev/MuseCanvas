import { AdminPluginsView } from '@/features/admin/components/admin-plugins-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '媒体插件 - MuseCanvas 管理后台',
}

export default function AdminPluginsPage() {
  return <AdminPluginsView />
}
