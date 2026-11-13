'use client'

import Link from 'next/link'
import { useEffect } from 'react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
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
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-canvas px-6 py-16">
      <BrandMark size={44} />
      <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-3 text-center">
        <p className="font-mono text-overline text-muted-foreground">出错了</p>
        <h1 className="text-title text-foreground">页面没能按预期加载</h1>
        <p className="text-sm text-muted-foreground">
          可以先重试一次。如果反复出现，把当前页面、时间和下面的错误编号告诉管理员，便于定位问题。
        </p>
        {error.digest ? (
          <p className="font-mono text-caption text-muted-foreground">错误编号 {error.digest}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={reset}>重试</Button>
        <Button variant="secondary" asChild>
          <Link href={APP_ROUTES.home}>返回首页</Link>
        </Button>
      </div>
    </main>
  )
}
