'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { ArrowClockwiseIcon, HouseIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'

/**
 * 路由级错误边界（`app/error.tsx`）：保留根布局与全局样式，只替换出错的路由段。
 * 文案按产品页写，不暴露堆栈；`digest` 只是便于运维对日志的编号。
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] route error:', error)
  }, [error])

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 py-16">
      <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-7 rounded-panel border border-border bg-surface p-8 text-center shadow-soft sm:p-10">
        <BrandMark size={40} />

        <div className="flex flex-col items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-danger-soft px-3 py-1 font-mono text-caption font-medium text-danger">
            <WarningCircleIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
            出错了
          </span>
          <h1 className="font-display text-title text-foreground">页面没能按预期加载</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            可以先重试一次。如果反复出现，把当前页面、时间和下面的错误编号告诉管理员，便于定位问题。
          </p>
          {error.digest ? (
            <p className="rounded-pill border border-border bg-tonal px-3 py-1 font-mono text-caption text-muted-foreground">
              错误编号 {error.digest}
            </p>
          ) : null}
        </div>

        <div className="flex w-full flex-wrap items-center justify-center gap-3">
          <Button onClick={reset} className="rounded-pill px-5">
            <ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            重试
          </Button>
          <Button variant="secondary" asChild className="rounded-pill px-5">
            <Link href={APP_ROUTES.home}>
              <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
              返回首页
            </Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
