import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { WorkspaceShell } from '@/features/workspace/components/workspace-shell'
import { APP_ROUTES, loginHref } from '@/shared/lib/app-routes'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import { getSessionUser } from '@/shared/services/server-api'

export const dynamic = 'force-dynamic'

/** Narrow preview boundary: account/admin authentication is never replaced by mock data. */
export default async function StudioLayout({ children }: { children: ReactNode }) {
  const user = WORKSPACE_MODE === 'live' ? await getSessionUser() : null
  if (WORKSPACE_MODE === 'live' && !user) {
    redirect(loginHref(APP_ROUTES.generate))
  }
  return <WorkspaceShell mode={WORKSPACE_MODE} user={user}>{children}</WorkspaceShell>
}
