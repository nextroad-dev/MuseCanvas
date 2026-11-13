import type { ReactNode } from 'react'
import Link from 'next/link'

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
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex min-h-[var(--layout-header)] w-full max-w-[var(--container-content)] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <Link
            href={APP_ROUTES.home}
            aria-label="返回 MuseCanvas 首页"
            className="flex items-center gap-2 rounded-control"
          >
            <BrandMark variant="mark" height={19} />
            <span className="text-compact font-medium text-foreground">MuseCanvas</span>
          </Link>
          <Badge tone="neutral">系统初始化</Badge>
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}
