import Link from 'next/link'
import { BrandMark } from '@/shared/components/brand-mark'
import { ContentFrame } from '@/shared/components/content-frame'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

export interface SiteFooterProps {
  current?: 'landing' | 'terms' | 'privacy'
  className?: string
}

const footerLink = 'rounded-control px-0 py-1 text-xs transition-colors hover:text-foreground'

const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'
const REPO_URL = 'https://github.com/nextroad-dev/MuseCanvas'

const landingLinkClass = 'text-sm text-foreground/85 transition-colors hover:text-foreground'

/**
 * Landing footer from the design mock: tagline, three link columns with mono
 * headings (产品 / 部署 / 法律), and the copyright line. Below `sm` the bottom
 * padding clears the fixed mobile CTA bar.
 */
function LandingFooter({ className }: { className?: string }) {
  return (
    <footer className={cn('bg-canvas max-sm:pb-[calc(6rem_+_env(safe-area-inset-bottom))]', className)}>
      <div className="mx-auto box-border flex w-full max-w-[80rem] flex-col gap-14 px-4 pb-10 pt-16 sm:px-6 md:px-10 md:pt-18">
        <div className="flex flex-wrap justify-between gap-10">
          <div className="flex max-w-xs flex-col gap-3.5">
            <span className="flex items-center gap-2.5">
              <BrandMark variant="mark" className="h-[17px]" />
              <span className="text-base font-medium tracking-[-0.01em] text-foreground">MuseCanvas</span>
            </span>
            <p className="text-base text-muted-foreground">可以装在自己服务器上的 AI 画图工具。</p>
          </div>

          <div className="flex flex-wrap gap-x-16 gap-y-10">
            <nav aria-label="产品" className="flex flex-col gap-2.5">
              <p className="font-mono text-xs text-muted-foreground">产品</p>
              <Link href="#works" className={landingLinkClass}>作品</Link>
              <Link href="#capabilities" className={landingLinkClass}>能力</Link>
              <Link href="#workflow" className={landingLinkClass}>流程</Link>
              <Link href={GENERATE_ROUTE} className={landingLinkClass}>创作台</Link>
            </nav>
            <nav aria-label="部署" className="flex flex-col gap-2.5">
              <p className="font-mono text-xs text-muted-foreground">部署</p>
              <a href={DEPLOY_DOC_URL} rel="noopener noreferrer" className={landingLinkClass}>部署说明</a>
              <a href={REPO_URL} rel="noopener noreferrer" className={landingLinkClass}>源码仓库</a>
            </nav>
            <nav aria-label="法律" className="flex flex-col gap-2.5">
              <p className="font-mono text-xs text-muted-foreground">法律</p>
              <Link href="/terms" className={landingLinkClass}>用户协议</Link>
              <Link href="/privacy" className={landingLinkClass}>隐私政策</Link>
            </nav>
          </div>
        </div>

        <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-6 font-mono text-xs text-muted-foreground">
          <span>© 2026 MuseCanvas</span>
        </div>
      </div>
    </footer>
  )
}

/**
 * Footer shared by the landing and legal pages.
 *
 * Landing gets the mock's footer. The legal pages keep the original single-row
 * band: a plain band with a single top rule. Every link is a real `<Link>` with
 * the global focus ring. The current document wears `bg-tonal-selected`.
 */
export function SiteFooter({ current, className }: SiteFooterProps) {
  if (current === 'landing') return <LandingFooter className={className} />

  return (
    <footer className={cn('border-t border-border', className)}>
      <ContentFrame className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">&copy; MuseCanvas</p>

        <nav aria-label="页脚导航" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/" className={cn(footerLink, 'text-muted-foreground')}>
            首页
          </Link>
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
