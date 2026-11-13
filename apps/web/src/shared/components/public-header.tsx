import Link from 'next/link'
import { BrandMark } from '@/shared/components/brand-mark'
import { PublicMobileNav } from '@/shared/components/public-mobile-nav'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/** 公共页统一内容栏：设计稿 1280px 内容区（页头 / 页脚 / 法律页共用）。 */
export const PUBLIC_FRAME = 'mx-auto box-border w-full max-w-[80rem] px-4 sm:px-6 md:px-10'

export interface PublicHeaderProps {
  className?: string
}

/** 桌面「登录」是文字链接而不是按钮（画板 01）：hover 只换色，不加底色。 */
const loginLink =
  'inline-flex min-h-[var(--control-touch)] items-center text-sm font-medium text-foreground underline-offset-4 transition-colors hover:underline'

/** 「进入创作台」40px 主按钮，比正文按钮矮一档。 */
const primaryLink = cn(
  buttonVariants({ variant: 'primary', size: 'md' }),
  'min-h-[var(--control-md)] px-[18px] text-sm',
)

/**
 * `/`、`/terms`、`/privacy` 共用的顶栏（server component）。
 *
 * 版式来自画板 01：sticky 64px、canvas 95% + backdrop blur、底部 hairline；
 * 左侧品牌 lockup，右侧登录 / 进入创作台。<640px 只留品牌与 44px 菜单按钮，
 * 菜单面板是唯一的 client island（`PublicMobileNav`）。
 * 跳转链接和 `main#main` 由这里与各页面配合，保证纯键盘可达。
 */
export function PublicHeader({ className }: PublicHeaderProps) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
      >
        跳到主要内容
      </a>

      <header
        className={cn(
          'sticky top-0 z-sticky border-b border-border bg-canvas/95 backdrop-blur',
          className,
        )}
      >
        <div className={cn(PUBLIC_FRAME, 'flex h-[var(--layout-public-header)] items-center justify-between gap-4')}>
          <Link
            href={APP_ROUTES.home}
            aria-label="MuseCanvas 首页"
            className="flex min-w-0 items-center rounded-control"
          >
            {/* 画板 04：移动端标志 17px、桌面 19px；lockup 已含 wordmark。 */}
            <BrandMark variant="lockup" height={17} className="sm:hidden" />
            <BrandMark variant="lockup" height={19} className="hidden sm:inline-flex" />
          </Link>

          <div className="flex shrink-0 items-center gap-5">
            <Link href={APP_ROUTES.login} className={cn(loginLink, 'hidden sm:inline-flex')}>
              登录
            </Link>
            <Link href={APP_ROUTES.generate} className={cn(primaryLink, 'hidden sm:inline-flex')}>
              进入创作台
            </Link>
            <PublicMobileNav />
          </div>
        </div>
      </header>
    </>
  )
}
