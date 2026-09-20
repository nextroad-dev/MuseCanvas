import { GenerateConsole } from '@/features/generate/components/generate-console'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '创作工作台 - MuseCanvas',
  description: 'AI 图像与视频生成工作室与控制台',
}

export default function GeneratePage() {
  // The console mirrors its 图像/视频 tab into `?tab=`, so it reads search params
  // and needs a boundary like every other `useSearchParams` consumer.
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">正在加载创作台...</div>}>
      <GenerateConsole />
    </Suspense>
  )
}
