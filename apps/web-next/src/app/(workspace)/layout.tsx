import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
import { WorkspaceHeader } from '@/features/workspace/components/workspace-header'

export const dynamic = 'force-dynamic'

export default async function WorkspaceLayout({
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
    redirect('/login')
  }

  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      <WorkspaceHeader initialUser={user} />
      <main className="flex min-h-0 flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
