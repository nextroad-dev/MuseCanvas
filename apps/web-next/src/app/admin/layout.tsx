import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { AdminShell } from '@/features/admin/components/admin-shell'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '管理后台 - MuseCanvas',
  description: 'MuseCanvas 系统管理与资源调度后台',
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const meRes = await serverApi.getMe()

  if (!meRes.success || !meRes.data) {
    redirect('/login?from=/admin')
  }

  if (meRes.data.role !== 'admin') {
    redirect('/generate')
  }

  return <AdminShell user={meRes.data}>{children}</AdminShell>
}
