import Link from 'next/link'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { cn } from '@/shared/lib/cn'

export interface PublicHeaderProps {
  current?: 'landing' | 'terms' | 'privacy'
  className?: string
}

/** 落地页桌面锚点导航：作品 / 产品能力 / 创作流程 / 条款。 */
const landingNav: { href: string; label: string; className: string }[] = [
  { href: '#works', label: '作品', className: 'hidden md:inline-flex' },
  { href: '#capabilities', label: '产品能力', className: 'hidden md:inline-flex' },
  { href: '#workflow', label: '创作流程', className: 'hidden md:inline-flex' },
  { href: '/terms', label: '条款', className: 'hidden sm:inline-flex' },
]

const desktopNavLink =
  'rounded-control px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground'
const headerLogin = buttonVariants({ variant: 'ghost', size: 'md' })
const headerPrimary = buttonVariants({ variant: 'primary', size: 'md' })

/** Legal switcher: one tonal track holding both documents, the current one selected. */
const legalTrack = 'hidden items-center gap-1 rounded-pill bg-tonal p-1 sm:flex'
const legalItem = 'rounded-pill px-3 py-1 text-sm transition-colors hover:text-foreground'

/**
 * Top navigation for public pages (landing, terms, privacy).
 *
 * Sizing & Layout Contract:
 * - Height is fixed to `h-[var(--layout-header)]` (56px) so every public page
 *   anchors its content to the same line.
 * - Sits in the shared `ContentFrame` gutters, on an opaque `bg-surface` band
 *   with a single rule (`border-b`): the header is a page edge, not a card.
 * - Brand mark is `h-5` (20px) plus the wordmark text; the sticky layer is `z-sticky`.
 * - Desktop navigation only. The mobile (<640px) menu button + drop-down panel
 *   belong to F2: render `<PublicMobileNav />` at the marked slot below
 *   (a `'use client'` island; this file stays a server component).
 */
export function PublicHeader({ current = 'landing', className }: PublicHeaderProps) {
  const isLegal = current === 'terms' || current === 'privacy'

  return (
    <header
      className={cn('sticky top-0 z-sticky border-b border-border bg-surface', className)}
      aria-label="主导航"
    >
      <ContentFrame className="flex h-[var(--layout-header)] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-4 sm:gap-6">
          <Link
            href="/"
            className="flex min-w-0 shrink items-center gap-2.5 rounded-control"
            aria-label="MuseCanvas 首页"
          >
            <BrandMark variant="mark" priority className="h-5" />
            <span className="whitespace-nowrap text-base font-medium text-foreground">MuseCanvas</span>
          </Link>

          {/* On the legal pages the header carries the switch between the two documents. */}
          {isLegal && (
            <nav aria-label="法律条款切换" className={legalTrack}>
              <Link
                href="/terms"
                aria-current={current === 'terms' ? 'page' : undefined}
                className={cn(
                  legalItem,
                  current === 'terms'
                    ? 'bg-tonal-selected font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                用户协议
              </Link>
              <Link
                href="/privacy"
                aria-current={current === 'privacy' ? 'page' : undefined}
                className={cn(
                  legalItem,
                  current === 'privacy'
                    ? 'bg-tonal-selected font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                隐私政策
              </Link>
            </nav>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {current === 'landing' ? (
            <nav aria-label="页面导航" className="flex items-center gap-1">
              {landingNav.map((item) => (
                <Link key={item.href} href={item.href} className={cn(desktopNavLink, item.className)}>
                  {item.label}
                </Link>
              ))}
            </nav>
          ) : (
            <Link href="/" className={cn(desktopNavLink, 'hidden sm:inline-flex')}>
              返回首页
            </Link>
          )}

          {/* F2 挂载点：在此处渲染 <PublicMobileNav />（<640px 菜单按钮 + 顶部落下面板，'use client' island）。 */}

          <ThemeToggle />

          <Link href="/login" className={headerLogin}>
            登录
          </Link>
          <Link href="/login" className={cn(headerPrimary, 'hidden sm:inline-flex')}>
            开始创作
          </Link>
        </div>
      </ContentFrame>
    </header>
  )
}
