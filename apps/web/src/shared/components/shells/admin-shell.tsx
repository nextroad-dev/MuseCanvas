'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftIcon,
  CaretRightIcon,
  CpuIcon,
  FileTextIcon,
  GearSixIcon,
  HouseIcon,
  KeyIcon,
  ListChecksIcon,
  ListIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  TicketIcon,
  UserCircleIcon,
  UsersIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'

import {
  ADMIN_NAV_GROUPS,
  adminBreadcrumb,
  isAdminNavActive,
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from '@/features/admin/lib/admin-layout'
import type { AdminNavIconKey } from '@/features/admin/lib/admin-layout'
import { BrandMark } from '@/shared/components/brand-mark'
import {
  Avatar,
  DropdownMenu,
  ThemeToggle,
  buttonVariants,
  controlSquare,
  ghostIconButtonVariants,
  iconSize,
  touchTarget,
  touchTargetSquare,
  useToast,
} from '@/shared/components/ui'
import { useAuth } from '@/shared/hooks/useAuth'
import { useDialog } from '@/shared/hooks/useDialog'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { SessionUserDto } from '@/shared/types'

/** 全部 10 个管理后台导航项图标映射（纯模块 `admin-layout.ts` 仅持有键名）。 */
const ADMIN_NAV_ICONS: Record<AdminNavIconKey, PhosphorIcon> = {
  overview: HouseIcon,
  users: UsersIcon,
  invitations: TicketIcon,
  models: CpuIcon,
  providers: KeyIcon,
  plugins: PuzzlePieceIcon,
  prompt: FileTextIcon,
  jobs: ListChecksIcon,
  oauth: ShieldCheckIcon,
  settings: GearSixIcon,
}

const DESKTOP_SIDEBAR_NAV_ID = 'admin-sidebar-nav'
const MOBILE_DRAWER_ID = 'admin-mobile-nav-drawer'

const NAV_ITEM_BASE = cn(
  'relative flex min-h-[var(--control-md)] items-center gap-3 overflow-hidden whitespace-nowrap rounded-control px-3 text-ui transition-colors',
  touchTarget,
)

export interface AdminShellProps {
  /** RSC 守卫已确认的管理员会话；用于顶栏账户菜单展示。 */
  user: SessionUserDto
  className?: string
  mainClassName?: string
  children: ReactNode
}

/**
 * 管理后台统一外壳（与 `AppShell` 同构）：
 * - 桌面端（>=960px）：256px / 64px 可折叠左侧栏，持久化通过 `readSidebarCollapsed` / `writeSidebarCollapsed`。
 * - 移动端（<960px）：左滑抽屉（`useDialog` 焦点陷阱 + Esc + 滚动锁定）。
 * - 56px 粘性顶栏：移动菜单按钮 + 面包屑 + 「返回创作台」按钮 + 主题切换 + 管理员账户菜单。
 * - 主区域：`max-w-[var(--container-content)]` 居中画布。
 */
export function AdminShell({ user, className, mainClassName, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { toast } = useToast()
  const { logout } = useAuth()

  // SSR 与首帧固定展开，挂载后读取用户持久化偏好，确保 hydration 一致。
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    setCollapsed(readSidebarCollapsed())
  }, [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])
  const openMobile = useCallback(() => setMobileOpen(true), [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

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
      writeSidebarCollapsed(next)
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

  const breadcrumb = adminBreadcrumb(pathname)

  const renderSidebarBody = (isMobile: boolean) => {
    const isCollapsed = !isMobile && collapsed
    const onNavClick = isMobile ? closeMobile : undefined

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div
          className={cn(
            'mb-1 flex h-10 shrink-0 items-center gap-2 px-1',
            isCollapsed ? 'justify-center' : 'justify-between',
          )}
        >
          <Link
            href={APP_ROUTES.admin}
            onClick={onNavClick}
            aria-label="管理后台首页"
            className={cn(
              'flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-control',
              isCollapsed && 'hidden',
            )}
          >
            <BrandMark variant="mark" size={30} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-compact font-semibold leading-tight tracking-tight text-foreground">
                MuseCanvas
              </span>
              <span className="truncate text-caption text-muted-foreground">管理控制台</span>
            </div>
          </Link>

          {isMobile ? (
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeMobile}
              aria-label="关闭后台导航"
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
          aria-label="后台导航"
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        >
          {ADMIN_NAV_GROUPS.map((group, groupIndex) => (
            <div
              key={group.title ?? `group-${groupIndex}`}
              className={cn('flex flex-col gap-0.5', groupIndex > 0 && 'mt-2')}
            >
              {group.title && !isCollapsed ? (
                <span className="overflow-hidden whitespace-nowrap px-3 pb-1 pt-2 font-mono text-overline uppercase text-muted-foreground">
                  {group.title}
                </span>
              ) : null}
              {group.items.map((item) => {
                const Icon = ADMIN_NAV_ICONS[item.icon]
                const active = isAdminNavActive(pathname, item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavClick}
                    aria-current={active ? 'page' : undefined}
                    aria-label={isCollapsed ? item.label : undefined}
                    title={item.label}
                    className={cn(
                      NAV_ITEM_BASE,
                      isCollapsed ? 'justify-center px-0' : 'justify-start',
                      active
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-muted-foreground hover:bg-tonal hover:text-foreground',
                    )}
                  >
                    <Icon
                      weight={active ? 'duotone' : 'regular'}
                      aria-hidden="true"
                      className={cn(iconSize.sm, 'shrink-0')}
                    />
                    {!isCollapsed ? <span className="truncate">{item.label}</span> : null}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto shrink-0 border-t border-border pt-3">
          <Link
            href={APP_ROUTES.generate}
            onClick={onNavClick}
            aria-label={isCollapsed ? '返回创作台' : undefined}
            title="返回创作台"
            className={cn(
              NAV_ITEM_BASE,
              'text-muted-foreground hover:bg-tonal hover:text-foreground',
              isCollapsed ? 'justify-center px-0' : 'justify-start',
            )}
          >
            <ArrowLeftIcon weight="regular" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
            {!isCollapsed ? <span className="truncate">返回创作台</span> : null}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-dvh bg-canvas text-foreground', className)}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
      >
        跳到管理后台内容
      </a>

      {/* 桌面可折叠侧栏（>=960px） */}
      <aside
        aria-label="管理后台侧栏"
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-border bg-surface md:flex',
          'transition-[width] duration-[var(--motion-spring-gentle)] ease-spring-gentle',
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
                  管理后台导航
                </h2>
                {renderSidebarBody(true)}
              </div>
            </div>,
            portalTarget,
          )
        : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-sticky flex h-[var(--layout-header)] shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/90 px-4 backdrop-blur-md sm:px-6 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={openMobile}
              aria-expanded={mobileOpen}
              aria-controls={MOBILE_DRAWER_ID}
              aria-label="打开后台导航"
              className={cn(ghostIconButtonVariants({ size: 'md' }), touchTargetSquare, 'md:hidden')}
            >
              <ListIcon weight="bold" aria-hidden="true" className={iconSize.md} />
            </button>

            <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-ui">
              <Link
                href={APP_ROUTES.admin}
                className="shrink-0 rounded-control font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                管理后台
              </Link>
              {breadcrumb ? (
                <>
                  <CaretRightIcon aria-hidden="true" className={cn(iconSize.xs, 'shrink-0 text-muted-foreground')} />
                  {breadcrumb.group ? (
                    <>
                      <span className="hidden shrink-0 text-muted-foreground sm:inline">{breadcrumb.group}</span>
                      <CaretRightIcon
                        aria-hidden="true"
                        className={cn(iconSize.xs, 'hidden shrink-0 text-muted-foreground sm:inline')}
                      />
                    </>
                  ) : null}
                  <span className="truncate font-medium text-foreground">{breadcrumb.label}</span>
                </>
              ) : null}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={APP_ROUTES.generate}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'hidden sm:inline-flex')}
            >
              <ArrowLeftIcon weight="regular" aria-hidden="true" className={iconSize.sm} />
              <span>返回创作台</span>
            </Link>
            <ThemeToggle />
            <DropdownMenu
              menuLabel="管理员账户菜单"
              trigger={
                <button
                  type="button"
                  aria-label="管理员账户菜单"
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-pill',
                    controlSquare.sm,
                    touchTargetSquare,
                  )}
                >
                  <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
                </button>
              }
              header={
                <div className="mb-1 border-b border-border px-3 pb-2 pt-1.5">
                  <p className="truncate text-xs font-medium text-foreground" title={user.email}>
                    {user.email}
                  </p>
                  <p className="mt-0.5 text-caption text-muted-foreground">管理员</p>
                </div>
              }
              items={[
                {
                  id: 'account',
                  label: '账户设置',
                  icon: <UserCircleIcon weight="regular" aria-hidden="true" className={iconSize.sm} />,
                  onSelect: () => router.push(APP_ROUTES.account),
                },
                {
                  id: 'logout',
                  label: loggingOut ? '正在退出…' : '退出登录',
                  icon: <SignOutIcon weight="regular" aria-hidden="true" className={iconSize.sm} />,
                  danger: true,
                  separator: true,
                  disabled: loggingOut,
                  onSelect: () => {
                    void handleLogout()
                  },
                },
              ]}
            />
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className={cn(
            'mx-auto flex w-full max-w-[var(--container-content)] flex-1 flex-col px-4 py-6 outline-none sm:px-6 md:px-8',
            mainClassName,
          )}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
