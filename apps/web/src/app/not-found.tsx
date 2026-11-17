import Link from 'next/link'
import { ArrowRightIcon, CompassIcon, HouseIcon } from '@phosphor-icons/react/ssr'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'

/** 404：无 JS 也要能读懂并离开，所以全部是服务端渲染的静态链接。 */
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 py-16">
      <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-7 rounded-panel border border-border bg-surface p-8 text-center shadow-soft sm:p-10">
        <BrandMark size={40} />

        <div className="flex flex-col items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-soft px-3 py-1 font-mono text-caption font-medium text-accent">
            <CompassIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
            404
          </span>
          <h1 className="font-display text-title text-foreground">没有找到这个页面</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            链接可能已经失效，或者页面被移动过。回到首页，或直接进入创作台继续。
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center justify-center gap-3">
          <Button asChild className="rounded-pill px-5">
            <Link href={APP_ROUTES.home}>
              <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
              回到首页
            </Link>
          </Button>
          <Button variant="secondary" asChild className="rounded-pill px-5">
            <Link href={APP_ROUTES.generate}>
              进入创作台
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
