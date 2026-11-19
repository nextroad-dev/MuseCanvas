'use client'

import './globals.css'

import { useEffect } from 'react'
import { ArrowClockwiseIcon, HouseIcon, WarningOctagonIcon } from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Badge, Button, Card, controlSquare, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/**
 * 根布局级错误边界（`app/global-error.tsx`）：根布局自身异常时接管整份文档，
 * 因此必须自带 `<html>` / `<body>`，且不依赖 `AppProviders`、`ThemeToggle` 或客户端路由。
 * 返回首页使用原生 `<a>`，全部视觉均遵守 Cool Gray-White token 规范。
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
        <title>应用异常 · MuseCanvas</title>
      </head>
      <body className="min-h-dvh bg-canvas font-sans text-foreground antialiased">
        <div className="flex min-h-dvh flex-col">
          <header className="border-b border-border bg-surface/90 backdrop-blur-md">
            <div className="mx-auto flex h-[var(--layout-header)] w-full max-w-[var(--container-content)] items-center justify-between px-4 sm:px-6 md:px-10">
              <a
                href={APP_ROUTES.home}
                aria-label="MuseCanvas 首页"
                className="flex min-w-0 items-center rounded-control"
              >
                <BrandMark variant="lockup" height={19} />
              </a>
            </div>
          </header>

          <main className="flex flex-1 flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
            <div className="mx-auto w-full max-w-[var(--container-dialog-narrow)]">
              <Card density="none" className="items-center gap-6 p-7 text-center sm:p-8">
                <div
                  className={cn(
                    'inline-flex items-center justify-center rounded-card border border-danger-border bg-danger-soft text-danger',
                    controlSquare.lg,
                  )}
                >
                  <WarningOctagonIcon weight="duotone" aria-hidden="true" className={iconSize.lg} />
                </div>

                <div className="flex flex-col items-center gap-2.5">
                  <Badge tone="danger">系统错误</Badge>
                  <h1 className="text-title text-foreground">应用没能启动</h1>
                  <p className="text-sm text-muted-foreground">
                    根布局阶段发生了未捕获错误。可以先尝试重新加载；若持续失败，请检查服务端日志与运行环境配置。
                  </p>
                  {error.digest ? (
                    <p className="mt-1 rounded-pill border border-border bg-tonal px-3 py-1 font-mono text-caption tabular-nums text-muted-foreground">
                      错误编号 · {error.digest}
                    </p>
                  ) : null}
                </div>

                <div className="flex w-full flex-wrap items-center justify-center gap-2.5">
                  <Button
                    onClick={reset}
                    leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" />}
                  >
                    重试
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={APP_ROUTES.home}>
                      <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
                      <span>返回首页</span>
                    </a>
                  </Button>
                </div>
              </Card>
            </div>
          </main>
        </div>
      </body>
    </html>
  )
}
