import type { Metadata } from 'next'

import { AdminUsersView } from '@/features/admin/components/admin-users-view'

export const metadata: Metadata = {
  title: '用户管理',
  description: '检索站点注册用户，管理账号启用/停用状态或清理违规账户。',
}

export default function AdminUsersPage() {
  return <AdminUsersView />
}
