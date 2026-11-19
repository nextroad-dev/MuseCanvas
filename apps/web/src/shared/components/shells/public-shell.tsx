import type { ReactNode } from 'react'

import { PUBLIC_FRAME, PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { cn } from '@/shared/lib/cn'

export type PublicShellWidth = 'wide' | 'reading' | 'full'

export interface PublicShellProps {
  /** 当前公共路由：用于顶栏与页脚的 `aria-current` 高亮。 */
  current?: 'home' | 'terms' | 'privacy'
  /**
   * 主内容区宽度策略：
   * - `'wide'`（默认）：居中 `--container-content`（1280px）带响应式水平内边距。
   * - `'reading'`：居中 `--container-reading`（72ch）阅读栏，适合条款/隐私等长文页。
   * - `'full'`：全宽直出，由营销页各分节自行控制通栏背景与内部容器。
   */
  width?: PublicShellWidth
  /** 是否在顶栏下沿挂载纯 CSS 滚动阅读进度条（默认 `false`）。 */
  readingProgress?: boolean
  className?: string
  mainClassName?: string
  children: ReactNode
}

/**
 * 公共页统一外壳（严格 SSG-safe，兼容 `force-static`，不读取 cookies/headers）。
 * 组合 `PublicHeader`、按宽度约束的主内容容器与 `SiteFooter`。
 */
export function PublicShell({
  current,
  width = 'wide',
  readingProgress = false,
  className,
  mainClassName,
  children,
}: PublicShellProps) {
  const footerCurrent = current === 'terms' || current === 'privacy' ? current : undefined

  return (
    <div className={cn('flex min-h-dvh flex-col bg-canvas text-foreground', className)}>
      <PublicHeader current={current} />
      {readingProgress ? <div aria-hidden="true" className="motion-reading-progress" /> : null}

      <main id="main" tabIndex={-1} className={cn('flex-1 outline-none', mainClassName)}>
        {width === 'full' ? (
          children
        ) : width === 'reading' ? (
          <div className={cn(PUBLIC_FRAME, 'py-12 sm:py-16 md:py-20')}>
            <div className="mx-auto w-full max-w-[var(--container-reading)]">{children}</div>
          </div>
        ) : (
          <div className={PUBLIC_FRAME}>{children}</div>
        )}
      </main>

      <SiteFooter current={footerCurrent} />
    </div>
  )
}
