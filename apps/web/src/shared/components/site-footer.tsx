import Link from 'next/link'
import { ContentFrame } from '@/shared/components/content-frame'
import { cn } from '@/shared/lib/cn'

export interface SiteFooterProps {
  current?: 'landing' | 'terms' | 'privacy'
  className?: string
}

const footerLink = 'rounded-control px-0 py-1 text-[13px] transition-colors hover:text-foreground'

/**
 * Footer shared by the landing and legal pages.
 *
 * A plain band with a single top rule (the tonal band above it already closes
 * the page on landing). Brand line and navigation share one row from `sm`
 * up and stack on phones. The current document wears `bg-tonal-selected`.
 * Every link is a real `<Link>` with the global focus ring.
 */
export function SiteFooter({ current, className }: SiteFooterProps) {
  return (
    <footer className={cn('border-t border-border', className)}>
      <ContentFrame className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted-foreground">&copy; MuseCanvas</p>

        <nav aria-label="页脚导航" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {current !== 'landing' && (
            <Link href="/" className={cn(footerLink, 'text-muted-foreground')}>
              首页
            </Link>
          )}
          <Link
            href="/terms"
            aria-current={current === 'terms' ? 'page' : undefined}
            className={cn(
              footerLink,
              current === 'terms' ? 'bg-tonal-selected font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            用户协议
          </Link>
          <Link
            href="/privacy"
            aria-current={current === 'privacy' ? 'page' : undefined}
            className={cn(
              footerLink,
              current === 'privacy' ? 'bg-tonal-selected font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            隐私政策
          </Link>
        </nav>
      </ContentFrame>
    </footer>
  )
}
