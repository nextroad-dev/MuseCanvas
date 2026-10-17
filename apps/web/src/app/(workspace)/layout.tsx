import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
import { WorkspaceHeader } from '@/features/workspace/components/workspace-header'

export const dynamic = 'force-dynamic'

/**
 * Workspace shell (foundations.md → 管理后台布局).
 *
 * The workspace body fills the viewport below the full-bleed header. Content
 * pages own their ContentFrame and narrower inner reading/form columns.
 * This shell adds no horizontal padding; its main is the single page scroller.
 * Generation's interactive layout remains owned by the generation feature.
 */
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
    <div className="flex h-dvh flex-col bg-canvas text-foreground">
      <WorkspaceHeader initialUser={user} />
      <main className="flex min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-0 w-full flex-1 flex-col">{children}</div>
      </main>
    </div>
  )
}
