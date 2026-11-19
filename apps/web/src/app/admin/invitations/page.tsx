import type { Metadata } from 'next'

import { AdminInvitationsView } from '@/features/admin/components/admin-invitations-view'

export const metadata: Metadata = {
  title: '邀请码管理',
  description: '配置站点注册模式，生成、复制或撤销注册邀请码。',
}

export default function AdminInvitationsPage() {
  return <AdminInvitationsView />
}
