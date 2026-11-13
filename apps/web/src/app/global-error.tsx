'use client'

import { useEffect } from 'react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
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
        <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-16">
          <BrandMark size={44} />
          <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-3 text-center">
            <p className="font-mono text-overline text-muted-foreground">MuseCanvas</p>
            <h1 className="text-title text-foreground">应用没能启动</h1>
            <p className="text-sm text-muted-foreground">
              根布局阶段发生了未捕获错误。可以先重试；若持续失败，请检查服务端日志与运行环境配置。
            </p>
            {error.digest ? (
              <p className="font-mono text-caption text-muted-foreground">错误编号 {error.digest}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={reset}>重试</Button>
            <Button variant="secondary" asChild>
              <a href={APP_ROUTES.home}>返回首页</a>
            </Button>
          </div>
        </main>
      </body>
    </html>
  )
}
