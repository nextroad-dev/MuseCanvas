'use client'

import {
  useCallback,
  useEffect,
  useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { usePathname,
  useRouter } from 'next/navigation'
import { SignOutIcon as LogOut,
  ListIcon as Menu,
  GearSixIcon as Settings,
  XIcon as X } from '@phosphor-icons/react'
import type { User } from '@/shared/types'
import { useLogout } from '@/shared/hooks/useAuth'
import { useDialog } from '@/shared/hooks/useDialog'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { Avatar,
  DropdownMenu,
  IconButton,
  ThemeToggle,
  buttonVariants,
  controlSquare,
  iconSize,
} from '@/shared/components/ui'
import { ACCOUNT_ROUTE, ADMIN_ROUTE, navLabelFor, resolveActiveNavKey, workspaceNavItems } from '../lib/workspace-nav'

interface WorkspaceHeaderProps {
  initialUser: User
}

/**
 * `--breakpoint-md` is 960px in the token contract, so the media query has to say
 * 60rem — the previous 48rem kept the drawer open on tablets that were already
 * showing the desktop nav.
 */
const WORKSPACE_DESKTOP_BREAKPOINT_QUERY = '(min-width: 60rem)'

/** Scrim for the drawer: `--color-overlay` at `--opacity-overlay` (40% light, 55% dark). */
const SCRIM_BACKGROUND = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

/**
 * Segmented navigation (design 02): the container is a tonal well, the live
 * entry floats (`bg-surface shadow-soft`); brand green never marks selection.
 */
const segmentedItemClass = (isActive: boolean) =>
  cn(
    'flex min-h-[var(--control-md)] items-center justify-center rounded-control px-4 text-sm font-medium',
    'motion-press',
    isActive
      ? 'bg-surface text-foreground shadow-soft'
      : 'text-muted-foreground hover:text-foreground active:text-foreground',
  )

export function WorkspaceHeader({ initialUser }: WorkspaceHeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // The account menu's keyboard / outside-click behaviour lives in `DropdownMenu`;
  // this stays the single reason the header holds the state — a route change or the
  // drawer opening has to close a menu the header is no longer looking at.
  const [menuOpen, setMenuOpen] = useState(false)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const {
    mounted: drawerMounted,
    phase: drawerPhase,
    labelId: drawerLabelId,
    closeButtonRef: drawerCloseButtonRef,
    portalTarget: drawerPortalTarget,
    rootProps: drawerRootProps,
    dialogProps: drawerDialogProps,
  } = useDialog({ open: drawerOpen, onClose: closeDrawer })

  const logoutMutation = useLogout()

  const userInitial = initialUser.email?.charAt(0).toUpperCase() || 'U'
  const isAdmin = initialUser.role === 'admin'

  // Two routes, no modes: the pathname alone says which entry is live.
  const activeKey = resolveActiveNavKey(pathname)
  const currentPageName = navLabelFor(activeKey)

  useEffect(() => {
    closeDrawer()
    setMenuOpen(false)
  }, [pathname, closeDrawer])

  useEffect(() => {
    const breakpoint = window.matchMedia(WORKSPACE_DESKTOP_BREAKPOINT_QUERY)
    const closeOnDesktop = () => {
      if (breakpoint.matches) closeDrawer()
    }
    breakpoint.addEventListener('change', closeOnDesktop)
    return () => breakpoint.removeEventListener('change', closeOnDesktop)
  }, [closeDrawer])

  async function handleLogout() {
    await logoutMutation.mutateAsync()
    router.push('/login')
    router.refresh()
  }

  return (
    <>
      <header className="relative z-sticky flex h-[var(--layout-header)] shrink-0 items-center border-b border-border bg-surface">
        <ContentFrame className="flex items-center justify-between gap-3">
          <Link
            href={GENERATE_ROUTE}
            className="shrink-0 rounded-control flex items-center"
            aria-label="MuseCanvas 创作台"
          >
            <BrandMark variant="wordmark" priority className="h-6 w-auto" />
          </Link>

          {/* Desktop nav: 创作 / 图库 segmented control */}
          <nav className="hidden items-center gap-1 rounded-control bg-tonal p-1 md:flex" aria-label="主导航">
            {workspaceNavItems.map((item) => {
              const isActive = item.key === activeKey
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={segmentedItemClass(isActive)}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Mobile: page name */}
          <span className="min-w-0 truncate text-sm font-medium text-foreground md:hidden">{currentPageName}</span>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <ThemeToggle />

            {isAdmin && (
              <Link
                href={ADMIN_ROUTE}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden md:inline-flex')}
              >
                管理后台
              </Link>
            )}

            {/* Account menu — trigger, panel and keyboard contract are all
                `DropdownMenu`'s; the header only names the entries. */}
            <DropdownMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              triggerLabel={`账户菜单：${initialUser.email || '当前用户'}`}
              trigger={<Avatar size="md" initial={userInitial} surface="transparent" />}
              triggerClassName={cn(
                controlSquare.md,
                'text-sm font-medium text-foreground',
                menuOpen ? 'bg-tonal-selected' : 'bg-tonal hover:bg-tonal-hover active:bg-tonal-active',
              )}
              menuLabel="账户菜单"
              header={
                <p className="truncate px-3 py-2 text-xs text-muted-foreground">{initialUser.email}</p>
              }
              items={[
                { id: 'account', label: '安全设置', href: ACCOUNT_ROUTE, icon: <Settings weight="bold" aria-hidden="true" /> },
                {
                  id: 'logout',
                  label: '退出登录',
                  icon: <LogOut weight="bold" aria-hidden="true" />,
                  danger: true,
                  loading: logoutMutation.isPending,
                  onSelect: () => void handleLogout(),
                },
              ]}
            />

            {/* Mobile navigation trigger */}
            <IconButton
              variant="ghost"
              className="md:hidden"
              aria-label="打开导航菜单"
              onClick={() => {
                setMenuOpen(false)
                setDrawerOpen(true)
              }}
              icon={<Menu weight="bold" className={iconSize.md} aria-hidden="true" />}
            />
          </div>
        </ContentFrame>
      </header>

      {/* Mobile Drawer */}
      {drawerMounted && drawerPortalTarget && createPortal(
        <div
          {...drawerRootProps}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDrawer()
          }}
          className={`fixed inset-0 z-modal md:hidden ${
            drawerPhase === 'close' ? 'motion-fade-out pointer-events-none' : 'motion-fade-in'
          }`}
        >
          <div
            className="fixed inset-0"
            style={{ backgroundColor: SCRIM_BACKGROUND }}
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <div
            {...drawerDialogProps}
            className={`fixed inset-y-0 right-0 flex w-full max-w-xs flex-col bg-surface p-6 shadow-drawer ${
              drawerPhase === 'close' ? 'motion-drawer-out-right' : 'motion-drawer-in'
            }`}
          >
            <div className="flex items-center justify-between">
              <h2 id={drawerLabelId} className="text-module text-foreground">
                导航菜单
              </h2>
              <IconButton
                ref={drawerCloseButtonRef}
                variant="ghost"
                aria-label="关闭导航菜单"
                onClick={closeDrawer}
                icon={<X weight="bold" className={iconSize.md} aria-hidden="true" />}
              />
            </div>

            <nav className="mt-6 flex flex-col gap-1 rounded-control bg-tonal p-1" aria-label="抽屉导航">
              {workspaceNavItems.map((item) => {
                const isActive = item.key === activeKey
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    onClick={closeDrawer}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(segmentedItemClass(isActive), 'w-full')}
                  >
                    {item.label}
                  </Link>
                )
              })}

              {isAdmin && (
                <Link
                  href={ADMIN_ROUTE}
                  onClick={closeDrawer}
                  className={cn(buttonVariants({ variant: 'ghost' }), 'mt-6 w-full justify-start')}
                >
                  管理后台
                </Link>
              )}
            </nav>
          </div>
        </div>,
        drawerPortalTarget,
      )}
    </>
  )
}
