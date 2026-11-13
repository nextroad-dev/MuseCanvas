import { PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { Capabilities, CtaSection, FeaturesStrip, Hero, Workflow, WorksGallery } from '@/features/landing'

export const dynamic = 'force-static'

export const metadata = {
  title: '让创意快速落地',
  description:
    '把构想写成一段文字，AI 即刻生成画面，作品自动保存至图库。MuseCanvas 是可以装在自己服务器上的 AI 画图工具。',
}

/**
 * 落地页（画板 01）：顶栏 → 首屏 → 作品 → 平台特性 → 能力 → 流程 → 深色收尾 → 页脚。
 *
 * 整页 `force-static`，全部内容在服务端输出：没有 cookies()/headers()，
 * 唯一的 client island 是能力手风琴与移动端菜单，无 JS 时其余内容照样可见。
 */
export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      <PublicHeader />
      <main id="main" className="flex-1">
        <Hero />
        <WorksGallery />
        <FeaturesStrip />
        <Capabilities />
        <Workflow />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  )
}
