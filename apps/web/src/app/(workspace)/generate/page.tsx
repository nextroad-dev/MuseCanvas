import { Suspense } from 'react'
import { GenerateConsole } from '@/features/generate/components/generate-console'
import GenerateLoading from './loading'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'AI 创作台 - MuseCanvas',
  description: 'AI 图像与视频生成工作室与控制台',
}

/** The console consumes the one-shot ?tab= and ?canvas= deep links through
 * search params, so it needs a Suspense boundary; its fallback is the same
 * skeleton the route-level loading state shows. */
export default function GeneratePage() {
  return <Suspense fallback={<GenerateLoading />}><GenerateConsole /></Suspense>
}
