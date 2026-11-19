import Link from 'next/link'
import type { ReactNode } from 'react'

import { BrandMark } from '@/shared/components/brand-mark'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

export type FocusedShellWidth = 'narrow' | 'form' | 'split'

const WIDTH_CLASS: Record<FocusedShellWidth, string> = {
  narrow: 'max-w-[var(--container-dialog-narrow)]',
  form: 'max-w-[var(--container-form)]',
  split: 'max-w-[1040px]',
}

export interface FocusedShellProps {
  /** 主内容容器最大宽度：`narrow`(440px) / `form`(600px，默认) / `split`(1040px)。 */
  maxWidth?: FocusedShellWidth
  /** 顶栏右侧 `ThemeToggle` 左侧的可选插槽（如「返回首页」或帮助链接）。 */
  headerRight?: ReactNode
  /** 主内容区底部的可选辅助说明。 */
  footer?: ReactNode
  /** 内容少于一屏时是否垂直居中（默认 `true`）。 */
  centered?: boolean
  className?: string
  mainClassName?: string
  children: ReactNode
}

/**
 * 专注流程外壳（登录 / 安装向导等单一目标页面）：
 * 极简 56px 顶栏（左侧 BrandMark 链接到首页，右侧可选插槽 + 主题切换）+ 居中容器，
 * 绝不渲染顶部进度步骤条。
 */
export function FocusedShell({
  maxWidth = 'form',
  headerRight,
  footer,
  centered = true,
  className,
  mainClassName,
  children,
}: FocusedShellProps) {
  return (
    <div className={cn('flex min-h-dvh flex-col bg-canvas text-foreground', className)}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
      >
        跳到主要内容
      </a>

      <header className="sticky top-0 z-sticky border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-[var(--layout-header)] w-full max-w-[var(--container-content)] items-center justify-between gap-4 px-4 sm:px-6 md:px-10">
          <Link
            href={APP_ROUTES.home}
            aria-label="MuseCanvas 首页"
            className="flex min-w-0 items-center rounded-control"
          >
            <BrandMark variant="lockup" height={19} />
          </Link>

          <div className="flex shrink-0 items-center gap-2">
            {headerRight}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main
        id="main"
        tabIndex={-1}
        className={cn(
          'flex flex-1 flex-col px-4 py-8 outline-none sm:px-6 sm:py-12',
          centered && 'justify-center',
          mainClassName,
        )}
      >
        <div className={cn('mx-auto w-full', WIDTH_CLASS[maxWidth])}>{children}</div>
      </main>

      {footer ? (
        <footer className="px-4 pb-6 pt-2 text-center text-xs text-muted-foreground sm:px-6">
          {footer}
        </footer>
      ) : null}
    </div>
  )
}
