import type { Metadata } from 'next'
import { GenerateView } from '@/features/generate/components/generate-view'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'

export const metadata: Metadata = { title: '创作台', description: '描述灵感，选择模型，管理生成任务与作品。' }

export default function GeneratePage() {
  return <GenerateView mode={WORKSPACE_MODE} />
}
