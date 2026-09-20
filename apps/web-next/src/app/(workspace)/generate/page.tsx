import { GenerateConsole } from '@/features/generate/components/generate-console'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '创作工作台 - MuseCanvas',
  description: 'AI 图像生成工作室与控制台',
}

export default function GeneratePage() {
  return <GenerateConsole />
}
