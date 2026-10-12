import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
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
  const sessionRes = await serverApi.getMe()
  const user = sessionRes.success ? sessionRes.data?.user : undefined

  if (!user) {
    if (sessionRes.error?.code === 'UPSTREAM_UNAVAILABLE') {
      return <ServiceUnavailable />
    }
    redirect('/login?from=/admin')
  }

  if (user.role !== 'admin') {
    redirect('/generate')
  }

  return <AdminShell user={user}>{children}</AdminShell>
}
