'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeftIcon, ImagesIcon, SparkleIcon, UserCircleIcon } from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Badge, ThemeToggle } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import type { SessionUserDto } from '@/shared/types'
import { WorkspaceJobObserver } from './workspace-job-observer'

export interface WorkspaceShellProps {
  mode: WorkspaceMode
  user: SessionUserDto | null
  children: ReactNode
}

const navigation = [
  { href: APP_ROUTES.generate, label: '创作台', icon: SparkleIcon },
  { href: APP_ROUTES.library, label: '作品图库', icon: ImagesIcon },
]

/** Only the studio routes use this shell. Mock preview never supplies an authenticated actor. */
export function WorkspaceShell({ mode, user, children }: WorkspaceShellProps) {
  const pathname = usePathname()
  return (
    <div className="min-h-screen bg-canvas text-foreground md:grid md:grid-cols-[var(--layout-sidebar)_minmax(0,1fr)]">
      <WorkspaceJobObserver />
      <a href="#workspace-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-toast focus:rounded-control focus:bg-surface focus:px-4 focus:py-3">
        跳到工作区内容
      </a>
      <aside className="flex min-w-0 flex-col border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex min-h-[var(--layout-public-header)] items-center justify-between gap-3 px-4 md:px-5">
          <Link href={APP_ROUTES.home} aria-label="MuseCanvas 首页" className="rounded-control">
            <BrandMark size={32} />
          </Link>
          {mode === 'mock' ? <Badge tone="warning" className="md:hidden">Mock</Badge> : null}
        </div>
        <nav aria-label="创作工作区" className="flex gap-1 px-3 pb-3 md:flex-col md:gap-2 md:pt-5">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`)
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn(
                'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium transition-colors md:flex-none md:justify-start',
                active ? 'bg-tonal text-foreground' : 'text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
              )}>
                <Icon className="size-[var(--icon-md)] shrink-0" aria-hidden="true" />
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="hidden min-w-0 px-5 pb-5 md:mt-auto md:block">
          <p className="text-caption text-muted-foreground">把想法变成画面，把灵感留在这里。</p>
          <Link href={APP_ROUTES.home} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-control text-ui text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-[var(--icon-sm)]" aria-hidden="true" /> 返回首页
          </Link>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex min-h-[var(--layout-public-header)] flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-ui text-muted-foreground">我的创作空间</span>
            {mode === 'mock' ? <Badge tone="warning">示例预览</Badge> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <ThemeToggle />
            {user ? (
              <Link href={APP_ROUTES.account} className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-control px-2 text-ui text-muted-foreground hover:bg-tonal-hover hover:text-foreground">
                <UserCircleIcon className="size-[var(--icon-md)] shrink-0" aria-hidden="true" />
                <span className="hidden max-w-48 truncate sm:inline">{user.email}</span>
                <span className="sm:sr-only">账户</span>
              </Link>
            ) : <span className="text-caption text-muted-foreground">本地演示 · 未登录</span>}
          </div>
        </header>
        {mode === 'mock' ? (
          <div role="note" className="border-b border-warning-border bg-warning-soft px-4 py-3 text-ui text-warning md:px-8">
            <strong className="font-medium">Mock 数据模式</strong>
            <span> · 图片为本地示例，任务仅模拟状态变化，不调用生成服务；预览操作只影响本浏览器。</span>
          </div>
        ) : null}
        <main id="workspace-main" tabIndex={-1} className="mx-auto min-w-0 max-w-[var(--container-content)] px-4 py-6 outline-none md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  )
}
