import { Suspense } from 'react'
import type { Metadata } from 'next'
import { AgentConsoleView } from '@/features/agent-console/components/agent-console-view'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import StudioLoading from '../loading'

export const metadata: Metadata = {
  title: 'Agent 操作台',
  description: '多轮 Agent 会话、工具审批流、画布与产物工作台。',
}

export default function GeneratePage() {
  return (
    <Suspense fallback={<StudioLoading />}>
      <AgentConsoleView mode={WORKSPACE_MODE} />
    </Suspense>
  )
}
