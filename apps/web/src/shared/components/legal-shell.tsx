import type { ReactNode } from 'react'
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/ssr'
import { PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { ContentFrame } from '@/shared/components/content-frame'
import { iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'

export interface LegalSection {
  id: string
  title: string
}

interface LegalShellProps {
  title: string
  updatedAt: string
  current?: 'terms' | 'privacy'
  sections?: LegalSection[]
  children: ReactNode
}

/**
 * Frame for the terms / privacy pages. Those routes are `force-static`, so this
 * file stays a plain server component: no `cookies()`, no `headers()`, nothing
 * browser-only at module scope or during render.
 *
 * Reading layout:
 * - One reading column capped at `max-w-reading` (72ch), so a clause never runs
 *   past a comfortable line length.
 * - Sections are separated by a hairline rule and a 40px rhythm instead of boxes.
 * - Below 1280px the contents collapse into a native `<details>` band above the
 *   article (works without JavaScript). From 1280px the contents become a sticky
 *   rail beside the article.
 * - Gutters follow `ContentFrame`: 16px, then 24px from 640px, then 32px from 960px.
 */
export function LegalShell({ title, updatedAt, current = 'terms', sections = [], children }: LegalShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground antialiased">
      <PublicHeader current={current} />

      <main className="motion-page-enter flex-1 py-12 md:py-16 lg:py-20">
        <ContentFrame>
          <div
            className={cn(
              'grid grid-cols-[minmax(0,1fr)] gap-10',
              sections.length > 0 && 'lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16 xl:grid-cols-[16rem_minmax(0,1fr)]',
            )}
          >
            {/* Contents for narrower screens: a tinted band that opens in place. */}
            {sections.length > 0 && (
              <details className="group rounded-card bg-tonal lg:hidden">
                <summary className="flex min-h-[var(--control-md)] cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                  <span>
                    {title}目录（{sections.length} 条）
                  </span>
                  <CaretDown
                    weight="bold"
                    aria-hidden="true"
                    className={cn(iconSize.sm, 'shrink-0 text-muted-foreground transition-transform group-open:rotate-180')}
                  />
                </summary>
                <nav aria-label="条款目录导航" className="flex flex-col gap-1 px-2 pb-3">
                  {sections.map((section) => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      className="rounded-control px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-tonal-hover hover:text-foreground"
                    >
                      {section.title}
                    </a>
                  ))}
                </nav>
              </details>
            )}

            {/* Sticky contents rail on desktop: a thin rule, no box. */}
            {sections.length > 0 && (
              <aside
                aria-label="条款目录导航"
                className="hidden lg:sticky lg:top-[calc(var(--layout-header)+2rem)] lg:block lg:self-start"
              >
                <nav className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">{title}目录</h2>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{sections.length} 条</span>
                  </div>
                  <div className="flex max-h-[calc(100vh-12rem)] flex-col overflow-y-auto border-l border-border">
                    {sections.map((section) => (
                      <a
                        key={section.id}
                        href={`#${section.id}`}
                        title={section.title}
                        className="-ml-px truncate border-l border-transparent py-1.5 pl-4 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                      >
                        {section.title}
                      </a>
                    ))}
                  </div>
                </nav>
              </aside>
            )}

            {/* Document: header, then sections separated by rules. */}
            <article className="min-w-0 max-w-reading">
              <header className="flex flex-col gap-3 border-b border-border pb-8">
                <h1 className="text-title text-foreground [text-wrap:balance]">{title}</h1>
                <p className="text-sm text-muted-foreground">
                  最后更新：<time className="font-mono tabular-nums whitespace-nowrap text-foreground">{updatedAt}</time>
                </p>
              </header>

              <div className="mt-10 flex flex-col gap-10 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-10 [&_h2]:text-subtitle [&_h2]:font-normal [&_h2]:text-foreground [&_h2]:[text-wrap:balance] [&_p]:mt-3 [&_p]:text-base [&_p]:leading-[1.59] [&_p]:text-foreground [&_p]:[text-wrap:pretty] [&_p]:[overflow-wrap:break-word] [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-base [&_ul]:leading-[1.59] [&_ul]:text-foreground [&_li]:[text-wrap:pretty] [&_li]:[overflow-wrap:break-word] [&_strong]:font-medium [&_strong]:text-foreground">
                {children}
              </div>
            </article>
          </div>
        </ContentFrame>
      </main>

      <SiteFooter current={current} className="mt-16" />
    </div>
  )
}
