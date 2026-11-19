import { PublicShell } from '@/shared/components/shells'
import { Capabilities, CtaSection, FeaturesStrip, Hero, Workflow, WorksGallery } from '@/features/landing'

export const dynamic = 'force-static'

export const metadata = {
  title: '让创意快速落地',
  description:
    '把构想写成一段文字，AI 即刻生成画面，作品自动保存至图库。MuseCanvas 是可以装在自己服务器上的 AI 画图工具。',
}

/**
 * 落地页（/）：严格 `force-static` SSG，无 cookies()/headers()。
 * 由 `PublicShell`（`width="full"`）承接统一顶栏与页脚，各营销分节自带通栏背景与内部容器。
 */
export default function HomePage() {
  return (
    <PublicShell current="home" width="full">
      <Hero />
      <WorksGallery />
      <FeaturesStrip />
      <Capabilities />
      <Workflow />
      <CtaSection />
    </PublicShell>
  )
}
