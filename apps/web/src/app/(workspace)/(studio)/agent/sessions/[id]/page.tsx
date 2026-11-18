import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { AgentConsoleView } from '@/features/agent-console/components/agent-console-view'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import StudioLoading from '../../../loading'

// The studio RSC layout guards live sessions before mounting this client island.
export default async function AgentSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()
  return (
    <Suspense fallback={<StudioLoading />}>
      <AgentConsoleView mode={WORKSPACE_MODE} initialSessionId={id.toLowerCase()} />
    </Suspense>
  )
}
