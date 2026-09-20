import { GenerateConsole } from '@/features/generate/components/generate-console'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '创作工作台 - MuseCanvas',
  description: 'AI 图像与视频生成工作室与控制台',
}

export default function GeneratePage() {
  // The console still reads `?tab=` as a one-shot deep link into the creation
  // mode, so it remains a `useSearchParams` consumer and needs a boundary like
  // every other one. The mode itself is owned by `useGenerateUiStore.activeTab`,
  // which is what the workspace header's 作图 / 生视频 entries write.
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">正在加载创作台...</div>}>
      <GenerateConsole />
    </Suspense>
  )
}
