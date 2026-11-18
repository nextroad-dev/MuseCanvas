import type { ReactNode } from 'react'
import Link from 'next/link'
import { SlidersHorizontalIcon } from '@phosphor-icons/react/ssr'

import { BrandMark } from '@/shared/components/brand-mark'
import { Badge } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'

/**
 * `/setup` 的外框：极简顶栏（品牌 + 「系统初始化」标记）+ 页面底色。
 * 安装向导是首装期的匿名可达页面，本布局不读 Cookie、不做重定向——是否已完成
 * 由 `page.tsx` 的服务端状态决定。
 */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      <header className="sticky top-0 z-[var(--z-index-sticky)] border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex min-h-[var(--layout-header)] w-full max-w-[var(--container-content)] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <Link
            href={APP_ROUTES.home}
            aria-label="返回 MuseCanvas 首页"
            className="flex items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors hover:bg-surface-hover"
          >
            <BrandMark variant="lockup" height={20} responsive />
          </Link>
          <Badge tone="neutral" className="gap-1.5 px-3 py-1">
            <SlidersHorizontalIcon weight="bold" aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
            <span>系统初始化</span>
          </Badge>
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}
