'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  CaretDownIcon,
  ImagesIcon,
  ListChecksIcon,
  ListIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SparkleIcon,
  UserCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import { Avatar, Button, DropdownMenu, ThemeToggle, iconSize } from '@/shared/components/ui'
import { useAuth } from '@/shared/hooks/useAuth'
import { APP_ROUTES, agentConsoleInspectorRoute, isOnGenerate } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import type { SessionUserDto } from '@/shared/types'
import { WorkspaceJobObserver } from './workspace-job-observer'

export interface WorkspaceShellProps {
  mode: WorkspaceMode
  user: SessionUserDto | null
  /** Full-bleed console layout without boxed padding; defaults to true on Console routes. */
  fullBleed?: boolean
  children: ReactNode
}

const MOBILE_NAV_ID = 'workspace-mobile-nav'

interface NavItem {
  id: string
  href: string
  label: string
  icon: typeof SparkleIcon
  matchPrefix?: string
}

const PRIMARY_NAV: NavItem[] = [
  { id: 'generate', href: APP_ROUTES.generate, label: '操作台', icon: SparkleIcon, matchPrefix: APP_ROUTES.generate },
  { id: 'library', href: APP_ROUTES.library, label: '作品图库', icon: ImagesIcon, matchPrefix: APP_ROUTES.library },
  { id: 'artifacts', href: agentConsoleInspectorRoute('artifacts'), label: '任务与产物', icon: ListChecksIcon },
]

function isPathMatch(pathname: string, prefix?: string): boolean {
  if (!prefix) return false
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * Shared Agent Operation Console shell for studio & account routes.
 * Mock mode never fabricates a user or renders an account link.
 */
export function WorkspaceShell({ mode, user, fullBleed, children }: WorkspaceShellProps) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { logout } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const isFullConsole = fullBleed ?? isOnGenerate(pathname)
  const onAccount = isPathMatch(pathname, APP_ROUTES.account)

  // Close mobile drawer when Escape is pressed or viewport expands to desktop (>=960px).
  useEffect(() => {
    if (!mobileOpen || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    const query = window.matchMedia?.('(min-width: 960px)')
    const onMediaChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false)
    }
    if (query?.matches) setMobileOpen(false)
    window.addEventListener('keydown', onKeyDown)
    query?.addEventListener('change', onMediaChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      query?.removeEventListener('change', onMediaChange)
    }
  }, [mobileOpen])

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await logout()
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      setLoggingOut(false)
      setLogoutError(error instanceof Error ? error.message : '请检查网络后重试。')
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col bg-canvas text-foreground',
        isFullConsole ? 'h-dvh overflow-hidden' : 'min-h-dvh',
      )}
    >
      <WorkspaceJobObserver />
      <a
        href="#workspace-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-toast focus:rounded-control focus:bg-surface focus:px-4 focus:py-3 focus:shadow-floating"
      >
        跳到工作区内容
      </a>

      <header className="sticky top-0 z-dropdown min-h-[var(--layout-header)] border-b border-border bg-surface/95 backdrop-blur-md">
        <div className="flex min-h-[var(--layout-header)] w-full items-center justify-between gap-2 px-3 sm:gap-4 sm:px-4 md:px-6">
          {/* Left: mobile menu toggle + brand identity + primary desktop top nav */}
          <div className="flex min-w-0 items-center gap-2 md:gap-5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={mobileOpen ? '关闭导航菜单' : '打开导航菜单'}
              aria-expanded={mobileOpen}
              aria-controls={MOBILE_NAV_ID}
              onClick={() => setMobileOpen((open) => !open)}
              className="shrink-0 md:hidden"
              icon={
                mobileOpen ? (
                  <XIcon className={iconSize.md} aria-hidden="true" />
                ) : (
                  <ListIcon className={iconSize.md} aria-hidden="true" />
                )
              }
            />

            <Link
              href={APP_ROUTES.home}
              aria-label="MuseCanvas 首页"
              onClick={() => setMobileOpen(false)}
              className="inline-flex min-w-0 items-center gap-2 rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            >
              <BrandMark variant="mark" size={28} />
              <span className="truncate text-compact font-semibold tracking-tight text-foreground">
                MuseCanvas
              </span>
            </Link>

            <nav aria-label="工作区主导航" className="hidden items-center gap-1 md:flex">
              {PRIMARY_NAV.map(({ id, href, label, icon: Icon, matchPrefix }) => {
                const active = id === 'generate' ? isOnGenerate(pathname) : isPathMatch(pathname, matchPrefix)
                return (
                  <Link
                    key={id}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      if (
                        typeof window !== 'undefined' &&
                        isPathMatch(pathname, APP_ROUTES.generate) &&
                        id === 'artifacts'
                      ) {
                        window.dispatchEvent(
                          new CustomEvent('muse:open-inspector', { detail: { panel: id } }),
                        )
                      }
                    }}
                    className={cn(
                      'inline-flex min-h-[var(--control-sm)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill px-3 py-1.5 text-ui transition-colors',
                      active
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'font-medium text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(iconSize.sm, 'shrink-0')}
                      weight={active ? 'fill' : 'regular'}
                      aria-hidden="true"
                    />
                    <span>{label}</span>
                  </Link>
                )
              })}
            </nav>
          </div>

          {/* Right: optional admin link + theme + user account menu */}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {user?.role === 'admin' ? (
              <Link
                href={APP_ROUTES.admin}
                className="hidden min-h-[var(--control-sm)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border border-border bg-canvas/70 px-3 py-1 text-ui font-medium text-foreground transition-colors hover:bg-tonal-hover md:inline-flex"
              >
                <ShieldCheckIcon className={cn(iconSize.sm, 'shrink-0')} aria-hidden="true" />
                <span>管理后台</span>
              </Link>
            ) : null}

            <ThemeToggle />

            {user ? (
              <DropdownMenu
                menuLabel="账户菜单"
                align="end"
                trigger={
                  <button
                    type="button"
                    aria-label="账户菜单"
                    className="inline-flex min-h-[var(--control-sm)] max-w-48 items-center gap-2 rounded-pill border border-border bg-canvas/70 p-0.5 text-ui text-foreground transition-colors hover:bg-tonal-hover max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center lg:pr-2.5"
                  >
                    <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
                    <span className="hidden max-w-36 truncate text-ui font-medium lg:inline">
                      {user.email}
                    </span>
                    <CaretDownIcon
                      className={cn(iconSize.xs, 'hidden shrink-0 text-muted-foreground lg:inline')}
                      aria-hidden="true"
                    />
                  </button>
                }
                header={
                  <div className="mb-1 border-b border-border px-3 pb-2 pt-1.5">
                    <p className="truncate text-ui font-medium text-foreground">{user.email}</p>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      {user.role === 'admin' ? '管理员' : '创作者'}
                    </p>
                  </div>
                }
                items={[
                  {
                    id: 'account',
                    label: '账户设置',
                    icon: <UserCircleIcon className={iconSize.sm} aria-hidden="true" />,
                    onSelect: () => router.push(APP_ROUTES.account),
                  },
                  ...(user.role === 'admin'
                    ? [
                        {
                          id: 'admin',
                          label: '管理后台',
                          icon: <ShieldCheckIcon className={iconSize.sm} aria-hidden="true" />,
                          onSelect: () => router.push(APP_ROUTES.admin),
                        },
                      ]
                    : []),
                  {
                    id: 'logout',
                    label: loggingOut ? '正在退出…' : '退出登录',
                    icon: <SignOutIcon className={iconSize.sm} aria-hidden="true" />,
                    danger: true,
                    separator: true,
                    disabled: loggingOut,
                    onSelect: () => {
                      void handleLogout()
                    },
                  },
                ]}
              />
            ) : (
              <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">
                本地演示
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Mobile slide-down nav below <960px; unmounted when closed to avoid duplicate active links */}
      {mobileOpen ? (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 top-[var(--layout-header)] z-overlay bg-overlay/40 backdrop-blur-xs md:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div
            id={MOBILE_NAV_ID}
            role="dialog"
            aria-label="工作区移动导航"
            className="fixed inset-x-0 top-[var(--layout-header)] z-modal max-h-[calc(100dvh-var(--layout-header))] overflow-y-auto border-b border-border bg-surface px-4 pb-5 pt-3 shadow-modal md:hidden"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
              <span className="text-caption font-medium text-muted-foreground">
                工作区导航
              </span>
              {mode === 'mock' ? (
                <span className="text-caption text-muted-foreground">
                  Mock 演示
                </span>
              ) : null}
            </div>

            <nav aria-label="工作区移动导航" className="mt-3 flex flex-col gap-1">
              {PRIMARY_NAV.map(({ id, href, label, icon: Icon, matchPrefix }) => {
                const active = id === 'generate' ? isOnGenerate(pathname) : isPathMatch(pathname, matchPrefix)
                return (
                  <Link
                    key={id}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setMobileOpen(false)
                      if (
                        typeof window !== 'undefined' &&
                        isPathMatch(pathname, APP_ROUTES.generate) &&
                        id === 'artifacts'
                      ) {
                        window.dispatchEvent(
                          new CustomEvent('muse:open-inspector', { detail: { panel: id } }),
                        )
                      }
                    }}
                    className={cn(
                      'flex min-h-11 min-w-0 items-center gap-3 rounded-pill px-4 text-sm transition-colors',
                      active
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'font-medium text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(iconSize.md, 'shrink-0')}
                      weight={active ? 'fill' : 'regular'}
                      aria-hidden="true"
                    />
                    <span className="truncate">{label}</span>
                  </Link>
                )
              })}
            </nav>

            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
              {user ? (
                <>
                  <div className="flex min-w-0 items-center gap-3 rounded-card border border-border bg-canvas/60 px-3 py-2.5">
                    <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui font-medium text-foreground">{user.email}</p>
                      <p className="text-caption text-muted-foreground">
                        {user.role === 'admin' ? '管理员' : '创作者'}
                      </p>
                    </div>
                  </div>
                  <Link
                    href={APP_ROUTES.account}
                    aria-current={onAccount ? 'page' : undefined}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex min-h-11 min-w-0 items-center gap-3 rounded-pill px-4 text-sm transition-colors',
                      onAccount
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'font-medium text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
                    )}
                  >
                    <UserCircleIcon className={cn(iconSize.md, 'shrink-0')} aria-hidden="true" />
                    <span>账户设置</span>
                  </Link>
                  {user.role === 'admin' ? (
                    <Link
                      href={APP_ROUTES.admin}
                      onClick={() => setMobileOpen(false)}
                      className="flex min-h-11 min-w-0 items-center gap-3 rounded-pill px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-tonal-hover hover:text-foreground"
                    >
                      <ShieldCheckIcon className={cn(iconSize.md, 'shrink-0')} aria-hidden="true" />
                      <span>管理后台</span>
                    </Link>
                  ) : null}
                  <Button
                    variant="outline"
                    fullWidth
                    loading={loggingOut}
                    icon={<SignOutIcon className={iconSize.sm} aria-hidden="true" />}
                    onClick={() => {
                      setMobileOpen(false)
                      void handleLogout()
                    }}
                    className="mt-1 rounded-pill"
                  >
                    {loggingOut ? '正在退出…' : '退出登录'}
                  </Button>
                </>
              ) : (
                <div className="rounded-card border border-border bg-tonal/60 px-3 py-2.5">
                  <p className="text-caption font-medium text-foreground">本地演示 · 未登录</p>
                  <p className="mt-0.5 text-caption text-muted-foreground">
                    Mock 模式仅在本地浏览器模拟，不提供账户登录。
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {mode === 'mock' ? (
        <div
          role="note"
          className="border-b border-border/60 bg-tonal/70 px-4 py-1 text-center text-caption text-muted-foreground md:px-6"
        >
          <strong className="font-medium text-foreground">Mock 演示模式</strong>
          <span> · 本地浏览器模拟 Agent 与图库状态，不连接真实后端</span>
        </div>
      ) : null}

      {logoutError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-danger-border bg-danger-soft px-4 py-2 text-ui text-danger md:px-6"
        >
          <span className="min-w-0 break-words">退出登录失败：{logoutError}</span>
          <button
            type="button"
            onClick={() => setLogoutError(null)}
            className="shrink-0 rounded-control px-2 py-1 text-caption font-medium hover:bg-danger/(--opacity-ghost-hover)"
          >
            关闭
          </button>
        </div>
      ) : null}

      <main
        id="workspace-main"
        tabIndex={-1}
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col outline-none',
          isFullConsole
            ? 'w-full overflow-hidden'
            : 'mx-auto w-full max-w-[var(--container-content)] px-4 py-6 md:px-8 md:py-8',
        )}
      >
        {children}
      </main>
    </div>
  )
}
