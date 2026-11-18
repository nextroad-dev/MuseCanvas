import Link from 'next/link'
import { ArrowRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { PublicMobileNav } from '@/shared/components/public-mobile-nav'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/** 公共页统一内容栏：设计稿 1280px 内容区（页头 / 页脚 / 法律页共用）。 */
export const PUBLIC_FRAME = 'mx-auto box-border w-full max-w-[80rem] px-4 sm:px-6 md:px-10'

export interface PublicHeaderProps {
  className?: string
}

const NAV_ANCHORS = [
  { href: '/#works', label: '作品' },
  { href: '/#capabilities', label: '能力' },
  { href: '/#workflow', label: '流程' },
]

/** 桌面文字链接：hover 只换色，不加底色。 */
const navLink =
  'inline-flex min-h-[var(--control-touch)] items-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'

/** 「进入创作台」40px 主按钮，pill 圆角。 */
const primaryLink = cn(
  buttonVariants({ variant: 'primary', size: 'md' }),
  'min-h-[var(--control-md)] rounded-pill px-5 text-sm',
)

/**
 * `/`、`/terms`、`/privacy` 共用的顶栏（server component）。
 *
 * sticky 64px、surface/85 + backdrop-blur-md、底部 hairline；
 * 左侧品牌 lockup，中间锚点导航，右侧登录 / 进入创作台。<640px 只留品牌与 44px 菜单按钮，
 * 菜单面板是唯一的 client island（`PublicMobileNav`）。
 * 跳转链接和 `main#main` 由这里与各页面配合，保证纯键盘可达。
 */
export function PublicHeader({ className }: PublicHeaderProps) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-pill focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
      >
        跳到主要内容
      </a>

      <header
        className={cn(
          'sticky top-0 z-sticky border-b border-border bg-surface/85 backdrop-blur-md',
          className,
        )}
      >
        <div className={cn(PUBLIC_FRAME, 'flex h-[var(--layout-public-header)] items-center justify-between gap-4')}>
          <div className="flex min-w-0 items-center gap-8">
            <Link
              href={APP_ROUTES.home}
              aria-label="MuseCanvas 首页"
              className="flex min-w-0 items-center rounded-control"
            >
              <BrandMark variant="lockup" height={19} responsive />
            </Link>

            <nav aria-label="页面导航" className="hidden items-center gap-6 md:flex">
              {NAV_ANCHORS.map((item) => (
                <Link key={item.href} href={item.href} className={navLink}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-5">
            <Link href={APP_ROUTES.login} className={cn(navLink, 'hidden text-foreground sm:inline-flex')}>
              登录
            </Link>
            <Link href={APP_ROUTES.generate} className={cn(primaryLink, 'hidden sm:inline-flex')}>
              进入创作台
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>
            <PublicMobileNav />
          </div>
        </div>
      </header>
    </>
  )
}
