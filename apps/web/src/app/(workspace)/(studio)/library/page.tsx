import type { Metadata } from 'next'
import { StudioWorkspace } from '@/features/workspace/components/studio-workspace'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'

export const metadata: Metadata = { title: '作品图库', description: '浏览、查找与管理你的创作作品。' }

export default function LibraryPage() {
  return <StudioWorkspace mode={WORKSPACE_MODE} initialRoute="library" />
}
