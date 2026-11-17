'use client'

import { useEffect } from 'react'
import { ArrowClockwiseIcon, HouseIcon, WarningOctagonIcon } from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'

/**
 * 根布局级错误边界（`app/global-error.tsx`）：根布局本身崩溃时由它接管整份文档，
 * 所以必须自带 `<html>` / `<body>`，且不能依赖 `AppProviders`。
 *
 * 仅使用 token 工具类；返回首页用原生 `<a>` 而不是 `<Link>`——全局错误时不能假设
 * 客户端路由上下文完好。样式表万一没加载，原生控件本身仍然可点。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] global error:', error)
  }, [error])

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="bg-canvas font-sans text-foreground antialiased">
        <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
          <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-7 rounded-panel border border-border bg-surface p-8 text-center shadow-soft sm:p-10">
            <BrandMark size={40} />

            <div className="flex flex-col items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-danger-soft px-3 py-1 font-mono text-caption font-medium text-danger">
                <WarningOctagonIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
                MuseCanvas
              </span>
              <h1 className="font-display text-title text-foreground">应用没能启动</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                根布局阶段发生了未捕获错误。可以先重试；若持续失败，请检查服务端日志与运行环境配置。
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
                <a href={APP_ROUTES.home}>
                  <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
                  返回首页
                </a>
              </Button>
            </div>
          </div>
        </main>
      </body>
    </html>
  )
}
