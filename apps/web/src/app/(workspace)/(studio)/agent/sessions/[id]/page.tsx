import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isUuid } from '@musecanvas/contracts'
import { StudioWorkspace } from '@/features/workspace/components/studio-workspace'
import { defaultAgentDefinition } from '@/features/agent-console/lib/default-definition'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'

export const metadata: Metadata = {
  title: 'Agent 会话',
}

/** Stable deep link used by the Agent console and shared artifacts. */
export default async function AgentSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessionId = id.trim().toLowerCase()
  if (!isUuid(sessionId)) notFound()
  return (
    <StudioWorkspace
      mode={WORKSPACE_MODE}
      initialRoute="generate"
      initialSessionId={sessionId}
      defaultAgentDefinition={defaultAgentDefinition()}
    />
  )
}
