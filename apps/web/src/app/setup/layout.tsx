import { redirect } from 'next/navigation'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { serverApi } from '@/shared/services/server-api'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
import type { SetupStatusResponse } from '@/shared/types'

export const dynamic = 'force-dynamic'

export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const statusRes = await serverApi.get<SetupStatusResponse>(API_ENDPOINTS.setup.status)

  // 首装期没有管理员账号，向导的一次性领取码流程必须匿名可达；状态读取失败同样放行，
  // 因此这里只认 setupComplete === true，绝不提前要求会话。
  if (!statusRes.data?.setupComplete) {
    return <>{children}</>
  }

  const sessionRes = await serverApi.getMe()
  const user = sessionRes.success ? sessionRes.data?.user : undefined

  if (!user) {
    if (sessionRes.error?.code === 'UPSTREAM_UNAVAILABLE') {
      return <ServiceUnavailable />
    }
    redirect('/login?from=/admin/settings')
  }

  if (user.role !== 'admin') {
    redirect('/generate')
  }

  redirect('/admin/settings')
}
