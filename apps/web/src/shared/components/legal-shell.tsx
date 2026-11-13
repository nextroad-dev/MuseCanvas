import type { ReactNode } from 'react'
import { ArrowUpIcon } from '@phosphor-icons/react/ssr'
import { PUBLIC_FRAME, PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'

export interface LegalShellProps {
  title: string
  updatedAt: string
  current: 'terms' | 'privacy'
  children: ReactNode
}

/**
 * 条款 / 隐私页的统一版式（无画板，沿用 01 的字体与留白语言）。
 *
 * - 顶部 2px 阅读进度条来自 `globals.css` 的 `.motion-reading-progress`：
 *   只有支持 `animation-timeline: scroll()` 且允许动效时才 display，其余情况不渲染。
 * - 正文单栏 `--container-reading`（72ch），sticky 顶栏提供返回首页与登录入口。
 * - 正文层级由外层选择器统一给：节标题衬线 24px、段落 16px、列表 disc；
 *   每节之间用 hairline 分隔，而不是卡片。
 * - 文末「回到顶部」回到 `#main`，44px 触控目标。
 */
export function LegalShell({ title, updatedAt, current, children }: LegalShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      <PublicHeader />
      {/* 放在顶栏之后：同为 z-sticky，后出现的进度条才压在 header 上沿。 */}
      <div aria-hidden="true" className="motion-reading-progress" />

      <main id="main" className="flex-1 py-12 sm:py-16 md:py-20">
        <div className={PUBLIC_FRAME}>
          <article className="mx-auto w-full max-w-reading">
            <header className="flex flex-col gap-3 border-b border-border pb-8">
              <p className="font-mono text-caption uppercase tracking-[0.05em] text-muted-foreground">
                MuseCanvas · 法律文件
              </p>
              <h1 className="font-display text-headline text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground">
                最后更新：
                <time dateTime={updatedAt} className="font-mono tabular-nums text-foreground">
                  {updatedAt}
                </time>
              </p>
            </header>

            <div
              className={cn(
                'mt-10 flex flex-col',
                // 每节：衬线标题 + 段间距；节与节之间一条 hairline。
                '[&>section]:flex [&>section]:flex-col [&>section]:gap-4',
                '[&>section+section]:mt-10 [&>section+section]:border-t [&>section+section]:border-border [&>section+section]:pt-10',
                '[&>section]:scroll-mt-20',
                '[&>section>h2]:font-display [&>section>h2]:text-section [&>section>h2]:font-semibold [&>section>h2]:text-foreground',
                '[&>section>p]:text-base [&>section>p]:text-foreground [&>section>p]:[overflow-wrap:break-word]',
                '[&>section>p>strong]:font-medium [&>section>p>strong]:text-foreground',
                '[&>section>ul]:list-disc [&>section>ul]:space-y-1.5 [&>section>ul]:pl-5 [&>section>ul]:text-base [&>section>ul]:text-foreground',
                '[&>section>ul>li]:[overflow-wrap:break-word]',
              )}
            >
              {children}
            </div>

            <div className="mt-12 flex justify-end border-t border-border pt-6">
              <a
                href="#main"
                className="motion-press inline-flex min-h-[var(--control-touch)] items-center gap-2 rounded-control text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                回到顶部
                <ArrowUpIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
              </a>
            </div>
          </article>
        </div>
      </main>

      <SiteFooter current={current} />
    </div>
  )
}
