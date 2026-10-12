import Link from 'next/link'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { cn } from '@/shared/lib/cn'

export interface SiteFooterProps {
  current?: 'landing' | 'terms' | 'privacy'
  className?: string
}

const footerLink = 'rounded-control text-sm transition-colors hover:text-foreground'

/**
 * Footer shared by the landing and legal pages.
 *
 * A tonal band closes the page. Brand and navigation share one row from `sm`
 * up and stack on phones; the copyright line sits last, in its own rhythm.
 * Every link is a real `<Link>` with the global focus ring.
 */
export function SiteFooter({ current, className }: SiteFooterProps) {
  return (
    <footer className={cn('border-t border-border bg-tonal py-12 lg:py-16', className)}>
      <ContentFrame className="flex flex-col gap-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="flex w-fit items-center rounded-control" aria-label="返回 MuseCanvas 首页">
            <BrandMark variant="monochrome" className="h-8 w-auto sm:h-9" />
          </Link>

          <nav aria-label="页脚导航" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-muted-foreground">
            {current !== 'landing' && (
              <Link href="/" className={cn(footerLink, 'text-muted-foreground')}>
                首页
              </Link>
            )}
            <Link
              href="/terms"
              aria-current={current === 'terms' ? 'page' : undefined}
              className={cn(footerLink, current === 'terms' ? 'font-medium text-foreground' : 'text-muted-foreground')}
            >
              用户协议
            </Link>
            <Link
              href="/privacy"
              aria-current={current === 'privacy' ? 'page' : undefined}
              className={cn(footerLink, current === 'privacy' ? 'font-medium text-foreground' : 'text-muted-foreground')}
            >
              隐私政策
            </Link>
          </nav>
        </div>

        <p className="text-xs text-muted-foreground">&copy; 2026 MuseCanvas</p>
      </ContentFrame>
    </footer>
  )
}
