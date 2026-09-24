'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { GenerateModeTab, User } from '@/shared/types'
import { useLogout } from '@/shared/hooks/useAuth'
import { useGenerationMode } from '@/shared/hooks/useGenerationMode'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { navLabelFor, resolveActiveNavKey, workspaceNavItems } from '../lib/workspace-nav'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { LogOut, Menu, Settings, X } from 'lucide-react'

interface WorkspaceHeaderProps {
  initialUser: User
}

/** Shared by the desktop nav and the mobile drawer so the two cannot disagree. */
const navItemClass = (isActive: boolean) =>
  `flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-surface-subtle text-foreground'
      : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground'
  }`

export function WorkspaceHeader({ initialUser }: WorkspaceHeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const { mode, selectMode } = useGenerationMode()

  const logoutMutation = useLogout()

  const userInitial = initialUser.email?.charAt(0).toUpperCase() || 'U'
  const isAdmin = initialUser.role === 'admin'

  // 作图 and 生视频 share `/generate`, so the path alone cannot say which entry
  // is live — `mode` has to come in. See `resolveActiveNavKey`.
  const activeKey = resolveActiveNavKey(pathname, mode)
  const currentPageName = navLabelFor(activeKey)

  async function handleLogout() {
    setUserMenuOpen(false)
    await logoutMutation.mutateAsync()
    router.push('/login')
    router.refresh()
  }

  /** Mode entries also close the drawer; the route entries do it on their Link. */
  function handleModeSelect(next: GenerateModeTab) {
    setDrawerOpen(false)
    selectMode(next)
  }

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-3 bg-surface px-4 shadow-md sm:px-6">
        <Link
          href={GENERATE_ROUTE}
          className="flex items-center gap-2 rounded-[var(--radius-control)] text-foreground focus:outline-none"
          aria-label="MuseCanvas 创作台"
        >
          <span className="text-xl font-bold tracking-tight text-foreground">MuseCanvas</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
          {workspaceNavItems.map((item) => {
            const isActive = item.key === activeKey
            if (item.kind === 'route') {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={navItemClass(isActive)}
                >
                  {item.label}
                </Link>
              )
            }
            const Icon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => handleModeSelect(item.mode)}
                aria-current={isActive ? 'true' : undefined}
                className={navItemClass(isActive)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </button>
            )
          })}
        </nav>

        {/* Mobile: page name */}
        <span className="text-sm font-medium text-foreground md:hidden">{currentPageName}</span>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />

          {/* Admin link if admin */}
          {isAdmin && (
            <Link
              href="/admin"
              className="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:inline-flex"
            >
              管理后台
            </Link>
          )}

          {/* User Popover menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-subtle text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle-strong focus:outline-none"
              aria-label={`账户菜单：${initialUser.email || '当前用户'}`}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              {userInitial}
            </button>

            {userMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setUserMenuOpen(false)}
                  aria-hidden="true"
                />
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 min-w-[200px] rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-lg"
                >
                  <p className="truncate px-3 py-1.5 text-xs text-muted-foreground">
                    {initialUser.email}
                  </p>
                  <Link
                    href="/account"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
                  >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    安全设置
                  </Link>
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={logoutMutation.isPending}
                    className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-sm text-danger transition-colors hover:bg-danger-soft/20"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    退出登录
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Mobile menu hamburger */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:hidden"
            aria-label="打开导航菜单"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="fixed inset-0 bg-overlay/40 transition-opacity"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="motion-drawer-in fixed inset-y-0 right-0 z-50 flex w-full max-w-xs flex-col bg-surface p-6 shadow-xl">
            <div className="flex items-center justify-between pb-4">
              <span className="font-medium text-foreground">导航菜单</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-[var(--radius-control)] p-1 text-muted-foreground hover:text-foreground"
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="mt-4 flex flex-col gap-1" aria-label="抽屉导航">
              {workspaceNavItems.map((item) => {
                const isActive = item.key === activeKey
                if (item.kind === 'route') {
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      aria-current={isActive ? 'page' : undefined}
                      className={navItemClass(isActive)}
                    >
                      {item.label}
                    </Link>
                  )
                }
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleModeSelect(item.mode)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`${navItemClass(isActive)} w-full text-left`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {item.label}
                  </button>
                )
              })}

              {isAdmin && (
                <div className="mt-6">
                  <Link
                    href="/admin"
                    onClick={() => setDrawerOpen(false)}
                    className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
                  >
                    管理后台
                  </Link>
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  )
}
