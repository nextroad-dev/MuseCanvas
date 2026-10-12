import { AdminOAuthView } from '@/features/admin/components/admin-oauth-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'OAuth 管理 - MuseCanvas 管理后台',
}

export default function AdminOAuthPage() {
  return <AdminOAuthView />
}
