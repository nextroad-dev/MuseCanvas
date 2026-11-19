import Link from 'next/link'
import { ArrowRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { PublicMobileNav } from '@/shared/components/public-mobile-nav'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/** 公共页统一内容栏：1280px (`--container-content`)。 */
export const PUBLIC_FRAME = 'mx-auto box-border w-full max-w-[var(--container-content)] px-4 sm:px-6 md:px-10'

export interface PublicHeaderProps {
  current?: 'home' | 'terms' | 'privacy'
  className?: string
}

const NAV_LINKS: { href: string; label: string; key: 'home' | 'terms' | 'privacy' }[] = [
  { href: APP_ROUTES.home, label: '首页', key: 'home' },
  { href: APP_ROUTES.terms, label: '服务条款', key: 'terms' },
  { href: APP_ROUTES.privacy, label: '隐私政策', key: 'privacy' },
]

/**
 * 公共页顶栏（SSG-safe，无 cookies/headers）：
 * 60px sticky 毛玻璃顶栏，BrandMark + 导航链接 + 主题切换 + 登录/进入工作台 + 移动菜单。
 */
export function PublicHeader({ current, className }: PublicHeaderProps) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
      >
        跳到主要内容
      </a>

      <header
        className={cn(
          'sticky top-0 z-sticky border-b border-border bg-canvas/85 backdrop-blur-md',
          className,
        )}
      >
        <div
          className={cn(
            PUBLIC_FRAME,
            'flex h-[var(--layout-public-header)] items-center justify-between gap-4',
          )}
        >
          <div className="flex min-w-0 items-center gap-7">
            <Link
              href={APP_ROUTES.home}
              aria-label="MuseCanvas 首页"
              className="flex min-w-0 items-center rounded-control"
            >
              <BrandMark variant="lockup" height={19} responsive />
            </Link>

            <nav aria-label="页面导航" className="hidden items-center gap-1 md:flex">
              {NAV_LINKS.map((item) => {
                const active = current === item.key
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'inline-flex min-h-[var(--control-sm)] items-center rounded-control px-3 text-sm font-medium transition-colors',
                      active
                        ? 'bg-tonal text-foreground'
                        : 'text-muted-foreground hover:bg-tonal/70 hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <Link
              href={APP_ROUTES.login}
              className={cn(buttonVariants({ variant: 'ghost', size: 'md' }), 'hidden sm:inline-flex')}
            >
              登录
            </Link>
            <Link
              href={APP_ROUTES.generate}
              className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'hidden sm:inline-flex')}
            >
              进入工作台
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>
            <PublicMobileNav />
          </div>
        </div>
      </header>
    </>
  )
}
