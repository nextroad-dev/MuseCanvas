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

const navLink = buttonVariants({ variant: 'ghost', size: 'sm' })
const headerLogin = buttonVariants({ variant: 'primary', size: 'md' })

/** Legal switcher: one tonal track holding both documents, the current one lifted to surface. */
const legalTrack = 'hidden items-center gap-1 rounded-pill bg-tonal p-1 sm:flex'
const legalItem =
  'rounded-pill px-3 py-1 text-sm transition-colors hover:text-foreground'

/**
 * Top navigation for public pages (landing, terms, privacy).
 *
 * Sizing & Layout Contract:
 * - Height is fixed to `h-[var(--layout-header)]` (56px) so every public page
 *   anchors its content to the same line.
 * - Sits in the shared `ContentFrame` gutters, on an opaque `bg-surface` band
 *   with a single rule (`border-b`): the header is a page edge, not a card.
 * - Brand wordmark is `h-6` (24px); the sticky layer is `z-sticky`.
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
            className="flex min-w-0 shrink items-center rounded-control"
            aria-label="MuseCanvas 首页"
          >
            <BrandMark variant="wordmark" priority className="h-6 w-auto" />
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
                    ? 'bg-surface font-medium text-foreground'
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
                    ? 'bg-surface font-medium text-foreground'
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
            <>
              <Link href="#capabilities" className={cn(navLink, 'hidden md:inline-flex')}>
                产品能力
              </Link>
              <Link href="#workflow" className={cn(navLink, 'hidden md:inline-flex')}>
                创作流程
              </Link>
              <Link href="/terms" className={cn(navLink, 'hidden sm:inline-flex')}>
                用户协议
              </Link>
              <Link href="/privacy" className={cn(navLink, 'hidden sm:inline-flex')}>
                隐私政策
              </Link>
            </>
          ) : (
            <Link href="/" className={cn(navLink, 'hidden sm:inline-flex')}>
              返回首页
            </Link>
          )}

          <ThemeToggle />

          <Link href="/login" className={headerLogin}>
            登录
          </Link>
        </div>
      </ContentFrame>
    </header>
  )
}
