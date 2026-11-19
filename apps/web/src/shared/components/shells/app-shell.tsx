'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ImagesSquareIcon,
  ListIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SparkleIcon,
  UserCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import {
  Avatar,
  IconButton,
  ThemeToggle,
  ghostIconButtonVariants,
  iconSize,
  touchTarget,
  touchTargetSquare,
  useToast,
} from '@/shared/components/ui'
import { useAuth } from '@/shared/hooks/useAuth'
import { useDialog } from '@/shared/hooks/useDialog'
import { APP_ROUTES, isOnAdmin, isOnGenerate } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { SessionUserDto } from '@/shared/types'

const APP_SIDEBAR_STORAGE_KEY = 'musecanvas-app-sidebar'
const DESKTOP_SIDEBAR_NAV_ID = 'app-sidebar-nav'
const MOBILE_DRAWER_ID = 'app-mobile-nav-drawer'

function readAppSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

function writeAppSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(APP_SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    /* 忽略：折叠状态仍在当前会话内生效 */
  }
}

function isRoutePrefix(pathname: string | null | undefined, target: string): boolean {
  if (!pathname) return false
  const clean = pathname.split('?')[0].replace(/\/+$/, '') || '/'
  const normalizedTarget = target.replace(/\/+$/, '') || '/'
  return clean === normalizedTarget || clean.startsWith(`${normalizedTarget}/`)
}

function deriveHeaderTitle(pathname: string | null | undefined): string {
  if (isOnGenerate(pathname)) return '创作台'
  if (isRoutePrefix(pathname, APP_ROUTES.library)) return '作品图库'
  if (isRoutePrefix(pathname, APP_ROUTES.account)) return '账户设置'
  return '工作台'
}

export interface AppShellDrawerContextValue {
  mobileDrawerOpen: boolean
  openMobileDrawer: () => void
  closeMobileDrawer: () => void
}

const AppShellDrawerContext = createContext<AppShellDrawerContextValue>({
  mobileDrawerOpen: false,
  openMobileDrawer: () => {},
  closeMobileDrawer: () => {},
})

/** 供 full-bleed 工作区子组件在移动端打开或关闭侧栏抽屉。 */
export function useAppShellDrawer(): AppShellDrawerContextValue {
  return useContext(AppShellDrawerContext)
}

export interface AppShellProps {
  mode: WorkspaceMode
  user: SessionUserDto | null
  /** 侧栏展开时在主导航下方渲染的扩展插槽（如会话历史列表）。 */
  sidebarSlot?: ReactNode
  /** 顶栏右侧可选操作区。 */
  headerSlot?: ReactNode
  /** 顶栏标题；缺省时按当前路由推导。 */
  headerTitle?: string
  /**
   * 全高无内边距模式：
   * - `true`：用于 `/generate` 独占视口高度的工作区（桌面隐藏顶栏，移动端提供紧凑抽屉顶栏）。
   * - `false`（默认）：用于 `/library` 与 `/account`，带 56px 粘性顶栏 + `--container-workspace` 居中容器。
   */
  fullBleed?: boolean
  className?: string
  mainClassName?: string
  children: ReactNode
}

const NAV_ITEM_BASE = cn(
  'relative flex min-h-[var(--control-md)] items-center gap-3 overflow-hidden whitespace-nowrap rounded-control px-3 text-ui transition-colors',
  touchTarget,
)

/**
 * 工作区统一外壳（覆盖 `/generate`、`/library` 与 `/account`）：
 * - 桌面端（>=960px）：可折叠左侧栏（256px / 64px，持久化于 `localStorage['musecanvas-app-sidebar']`）。
 * - 移动端（<960px）：左滑抽屉（焦点陷阱 + Esc + 滚动锁定委托给 `useDialog`）。
 */
export function AppShell({
  mode,
  user,
  sidebarSlot,
  headerSlot,
  headerTitle,
  fullBleed = false,
  className,
  mainClassName,
  children,
}: AppShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { toast } = useToast()
  const { logout } = useAuth()

  // SSR 与首帧一律展开，挂载后读取用户持久化偏好，避免 hydration 不一致。
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    setCollapsed(readAppSidebarCollapsed())
  }, [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])
  const openMobile = useCallback(() => setMobileOpen(true), [])

  // 路由切换时自动关闭移动抽屉。
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // 视口拓宽到桌面断点（960px）时自动关闭移动抽屉。
  useEffect(() => {
    if (!mobileOpen) return
    const query = window.matchMedia('(min-width: 960px)')
    if (query.matches) {
      setMobileOpen(false)
      return
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [mobileOpen])

  const { mounted, phase, labelId, closeButtonRef, portalTarget, overlayProps, dialogProps } = useDialog({
    open: mobileOpen,
    onClose: closeMobile,
  })

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      writeAppSidebarCollapsed(next)
      return next
    })
  }, [])

  const handleLogout = useCallback(async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
      useAuthUiStore.getState().reset()
      setMobileOpen(false)
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      setLoggingOut(false)
      toast.error('退出登录失败', error instanceof Error ? error.message : '请检查网络后重试。')
    }
  }, [loggingOut, logout, router, toast])

  const drawerContextValue = useMemo<AppShellDrawerContextValue>(
    () => ({
      mobileDrawerOpen: mobileOpen,
      openMobileDrawer: openMobile,
      closeMobileDrawer: closeMobile,
    }),
    [mobileOpen, openMobile, closeMobile],
  )

  const resolvedTitle = headerTitle ?? deriveHeaderTitle(pathname)
  const generateActive = isOnGenerate(pathname)
  const libraryActive = isRoutePrefix(pathname, APP_ROUTES.library)
  const accountActive = isRoutePrefix(pathname, APP_ROUTES.account)
  const adminActive = isOnAdmin(pathname)
  const isLive = user !== null

  const primaryItems = [
    {
      href: APP_ROUTES.generate,
      label: '创作台',
      icon: SparkleIcon,
      active: generateActive,
    },
    {
      href: APP_ROUTES.library,
      label: '作品图库',
      icon: ImagesSquareIcon,
      active: libraryActive,
    },
  ] as const

  const renderSidebarBody = (isMobile: boolean) => {
    const isCollapsed = !isMobile && collapsed
    const onNavClick = isMobile ? closeMobile : undefined

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div
          className={cn(
            'flex h-10 shrink-0 items-center gap-2 px-1',
            isCollapsed ? 'justify-center' : 'justify-between',
          )}
        >
          <Link
            href={APP_ROUTES.generate}
            onClick={onNavClick}
            aria-label="MuseCanvas 创作台"
            className={cn(
              'flex min-w-0 items-center overflow-hidden whitespace-nowrap rounded-control',
              isCollapsed && 'hidden',
            )}
          >
            <BrandMark variant="lockup" height={18} />
          </Link>

          {isMobile ? (
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeMobile}
              aria-label="关闭导航菜单"
              className={cn(ghostIconButtonVariants({ size: 'md' }), touchTargetSquare)}
            >
              <XIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </button>
          ) : (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={isCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!isCollapsed}
              aria-controls={DESKTOP_SIDEBAR_NAV_ID}
              className={ghostIconButtonVariants({ size: 'md' })}
            >
              <SidebarSimpleIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
            </button>
          )}
        </div>

        <nav
          id={isMobile ? undefined : DESKTOP_SIDEBAR_NAV_ID}
          aria-label="主导航"
          className="flex shrink-0 flex-col gap-1"
        >
          {primaryItems.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavClick}
                aria-current={item.active ? 'page' : undefined}
                aria-label={isCollapsed ? item.label : undefined}
                title={item.label}
                className={cn(
                  NAV_ITEM_BASE,
                  isCollapsed ? 'justify-center px-0' : 'justify-start',
                  item.active
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted-foreground hover:bg-tonal hover:text-foreground',
                )}
              >
                <Icon
                  weight={item.active ? 'duotone' : 'regular'}
                  aria-hidden="true"
                  className={cn(iconSize.sm, 'shrink-0')}
                />
                {!isCollapsed ? <span className="truncate">{item.label}</span> : null}
              </Link>
            )
          })}
        </nav>

        {!isCollapsed && sidebarSlot ? (
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pt-3">{sidebarSlot}</div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-border pt-3">
          {isLive ? (
            <>
              <Link
                href={APP_ROUTES.account}
                onClick={onNavClick}
                aria-current={accountActive ? 'page' : undefined}
                aria-label={isCollapsed ? '账户设置' : undefined}
                title="账户设置"
                className={cn(
                  NAV_ITEM_BASE,
                  isCollapsed ? 'justify-center px-0' : 'justify-start',
                  accountActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted-foreground hover:bg-tonal hover:text-foreground',
                )}
              >
                <UserCircleIcon
                  weight={accountActive ? 'duotone' : 'regular'}
                  aria-hidden="true"
                  className={cn(iconSize.sm, 'shrink-0')}
                />
                {!isCollapsed ? <span className="truncate">账户设置</span> : null}
              </Link>

              {user.role === 'admin' ? (
                <Link
                  href={APP_ROUTES.admin}
                  onClick={onNavClick}
                  aria-current={adminActive ? 'page' : undefined}
                  aria-label={isCollapsed ? '管理后台' : undefined}
                  title="管理后台"
                  className={cn(
                    NAV_ITEM_BASE,
                    isCollapsed ? 'justify-center px-0' : 'justify-start',
                    adminActive
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-muted-foreground hover:bg-tonal hover:text-foreground',
                  )}
                >
                  <ShieldCheckIcon
                    weight={adminActive ? 'duotone' : 'regular'}
                    aria-hidden="true"
                    className={cn(iconSize.sm, 'shrink-0')}
                  />
                  {!isCollapsed ? <span className="truncate">管理后台</span> : null}
                </Link>
              ) : null}

              <div
                className={cn(
                  'mt-1.5 flex border-t border-border pt-2.5',
                  isCollapsed ? 'flex-col items-center gap-1.5' : 'flex-col gap-2',
                )}
              >
                {isCollapsed ? (
                  <>
                    <ThemeToggle />
                    <IconButton
                      variant="ghost"
                      size="icon"
                      aria-label={loggingOut ? '正在退出…' : '退出登录'}
                      title={loggingOut ? '正在退出…' : '退出登录'}
                      loading={loggingOut}
                      disabled={loggingOut}
                      onClick={() => {
                        void handleLogout()
                      }}
                      icon={<SignOutIcon weight="regular" aria-hidden="true" className={iconSize.sm} />}
                      className="text-muted-foreground hover:bg-danger-soft hover:text-danger"
                    />
                    <span title={user.email} className="inline-flex">
                      <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 items-center gap-2.5 px-1.5">
                      <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui font-medium text-foreground" title={user.email}>
                          {user.email}
                        </p>
                        <p className="truncate text-caption text-muted-foreground">
                          {user.role === 'admin' ? '管理员' : '成员'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-1 px-0.5">
                      <ThemeToggle />
                      <button
                        type="button"
                        disabled={loggingOut}
                        onClick={() => {
                          void handleLogout()
                        }}
                        className={cn(
                          'inline-flex min-h-[var(--control-md)] flex-1 items-center justify-center gap-2 rounded-control px-3 text-ui font-medium text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger disabled:is-disabled',
                          touchTarget,
                        )}
                      >
                        <SignOutIcon weight="regular" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
                        <span>{loggingOut ? '正在退出…' : '退出登录'}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div
              className={cn(
                'flex items-center gap-2',
                isCollapsed ? 'flex-col justify-center' : 'justify-between px-1.5',
              )}
            >
              <ThemeToggle />
              {!isCollapsed ? (
                <span className="truncate font-mono text-caption text-muted-foreground">
                  {mode === 'mock' ? '预览模式' : '访客模式'}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <AppShellDrawerContext.Provider value={drawerContextValue}>
      <div
        className={cn(
          'flex bg-canvas text-foreground',
          fullBleed ? 'h-dvh overflow-hidden' : 'min-h-dvh',
          className,
        )}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
        >
          跳到工作区内容
        </a>

        {/* 桌面可折叠侧栏（>=960px） */}
        <aside
          aria-label="工作区侧栏"
          className={cn(
            'hidden shrink-0 flex-col border-r border-border bg-surface md:flex',
            'transition-[width] duration-[var(--motion-spring-gentle)] ease-spring-gentle',
            fullBleed ? 'h-full overflow-hidden' : 'sticky top-0 h-dvh overflow-hidden',
            collapsed ? 'w-[var(--layout-sidebar-collapsed)]' : 'w-[var(--layout-sidebar)]',
          )}
        >
          {renderSidebarBody(false)}
        </aside>

        {/* 移动端左滑抽屉（<960px） */}
        {mounted && portalTarget
          ? createPortal(
              <div
                {...overlayProps}
                className={cn(
                  'fixed inset-0 z-modal md:hidden',
                  phase === 'exit' ? 'motion-fade-out' : 'motion-fade-in',
                )}
              >
                <div
                  aria-hidden="true"
                  onClick={closeMobile}
                  className="absolute inset-0 bg-overlay/40 backdrop-blur-xs dark:bg-overlay/55"
                />
                <div
                  {...dialogProps}
                  id={MOBILE_DRAWER_ID}
                  className={cn(
                    'absolute inset-y-0 left-0 flex w-[var(--layout-sidebar)] max-w-[85vw] flex-col border-r border-border bg-surface shadow-modal',
                    phase === 'exit' ? 'motion-drawer-out-left' : 'motion-drawer-in-left',
                  )}
                >
                  <h2 id={labelId} className="sr-only">
                    工作区导航
                  </h2>
                  {renderSidebarBody(true)}
                </div>
              </div>,
              portalTarget,
            )
          : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {fullBleed ? (
            <header className="flex h-[var(--layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/90 px-3 backdrop-blur-md md:hidden">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  onClick={openMobile}
                  aria-expanded={mobileOpen}
                  aria-controls={MOBILE_DRAWER_ID}
                  aria-label="打开导航菜单"
                  className={cn(ghostIconButtonVariants({ size: 'md' }), touchTargetSquare)}
                >
                  <ListIcon weight="bold" aria-hidden="true" className={iconSize.md} />
                </button>
                <span className="truncate text-sm font-medium text-foreground">{resolvedTitle}</span>
              </div>
              {headerSlot ? <div className="flex shrink-0 items-center gap-2">{headerSlot}</div> : null}
            </header>
          ) : (
            <header className="sticky top-0 z-sticky flex h-[var(--layout-header)] shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/90 px-4 backdrop-blur-md sm:px-6 md:px-8">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={openMobile}
                  aria-expanded={mobileOpen}
                  aria-controls={MOBILE_DRAWER_ID}
                  aria-label="打开导航菜单"
                  className={cn(ghostIconButtonVariants({ size: 'md' }), touchTargetSquare, 'md:hidden')}
                >
                  <ListIcon weight="bold" aria-hidden="true" className={iconSize.md} />
                </button>
                <h1 className="truncate text-compact font-semibold tracking-tight text-foreground">
                  {resolvedTitle}
                </h1>
              </div>

              {headerSlot ? <div className="flex shrink-0 items-center gap-2">{headerSlot}</div> : null}
            </header>
          )}

          <main
            id="main"
            tabIndex={-1}
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col outline-none',
              fullBleed
                ? 'w-full overflow-hidden'
                : 'mx-auto w-full max-w-[var(--container-workspace)] px-4 py-6 sm:px-6 md:px-8 md:py-8',
              mainClassName,
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </AppShellDrawerContext.Provider>
  )
}
