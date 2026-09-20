import { AdminUsersView } from '@/features/admin/components/admin-users-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '用户管理 - MuseCanvas 管理后台',
}

export default function AdminUsersPage() {
  return <AdminUsersView />
}
