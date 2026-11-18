import type { Metadata } from 'next'
import { StudioWorkspace } from '@/features/workspace/components/studio-workspace'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'

export const metadata: Metadata = {
  title: 'Agent 操作台',
  description: '多轮 Agent 会话、工具审批流、画布与产物工作台。',
}

export default function GeneratePage() {
  return <StudioWorkspace mode={WORKSPACE_MODE} initialRoute="generate" />
}
