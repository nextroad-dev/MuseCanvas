'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { User } from '@/shared/types'
import { useLogout } from '@/shared/hooks/useAuth'
import { LogOut, Menu, Settings, X } from 'lucide-react'

interface WorkspaceHeaderProps {
  initialUser: User
}

const navItems = [
  { name: 'generate', path: '/generate', label: '创作' },
  { name: 'library', path: '/library', label: '图库' },
]

export function WorkspaceHeader({ initialUser }: WorkspaceHeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  const logoutMutation = useLogout()

  const userInitial = initialUser.email?.charAt(0).toUpperCase() || 'U'
  const isAdmin = initialUser.role === 'admin'

  const activeItem = navItems.find((item) => pathname.startsWith(item.path))
  const currentPageName = activeItem?.label || ''

  async function handleLogout() {
    setUserMenuOpen(false)
    await logoutMutation.mutateAsync()
    router.push('/login')
    router.refresh()
  }

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <Link
          href="/generate"
          className="flex items-center gap-2 rounded-[var(--radius-control)] text-foreground focus:outline-none"
          aria-label="MuseCanvas 创作台"
        >
          <span className="text-xl font-bold tracking-tight text-foreground">MuseCanvas</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.path)
            return (
              <Link
                key={item.name}
                href={item.path}
                className={`flex min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-surface-subtle text-foreground'
                    : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* Mobile: page name */}
        <span className="text-sm font-medium text-foreground md:hidden">{currentPageName}</span>

        <div className="ml-auto flex items-center gap-2">
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
            className="fixed inset-0 bg-black/40 transition-opacity"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xs flex-col bg-surface p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-border pb-4">
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

            <nav className="mt-4 flex flex-col gap-1">
              {navItems.map((item) => {
                const isActive = pathname.startsWith(item.path)
                return (
                  <Link
                    key={item.name}
                    href={item.path}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-surface-subtle text-foreground'
                        : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground'
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}

              {isAdmin && (
                <div className="mt-4 border-t border-border pt-4">
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
