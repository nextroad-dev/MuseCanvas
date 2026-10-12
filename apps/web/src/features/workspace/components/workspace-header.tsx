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
import type { GenerateModeTab,
  User } from '@/shared/types'
import { useLogout } from '@/shared/hooks/useAuth'
import { useDialog } from '@/shared/hooks/useDialog'
import { useGenerationMode } from '@/shared/hooks/useGenerationMode'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
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
 * Shared by the desktop nav and the mobile drawer so the two cannot disagree.
 * The current entry is `tonal-selected` plus a 3px primary bar (foundations →
 * 选中态); brand green never marks selection.
 */
const navItemClass = (isActive: boolean) =>
  cn(
    'relative flex min-h-[var(--control-md)] items-center gap-2 rounded-control px-3 text-sm font-medium',
    'motion-press',
    isActive ? 'bg-tonal-selected text-foreground' : 'text-muted-foreground hover:bg-tonal-hover hover:text-foreground active:bg-tonal-active',
  )

/** `orientation` follows the nav: the desktop bar underlines, the drawer rules on the left. */
const activeBarClass = (horizontal: boolean) =>
  horizontal
    ? 'absolute inset-x-2 bottom-0 h-[3px] rounded-pill bg-primary'
    : 'absolute inset-y-1.5 left-0 w-[3px] rounded-pill bg-primary'

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
  const { mode, selectMode } = useGenerationMode()
  const submissionBusy = useGenerateUiStore((state) => state.isGenerating)

  const logoutMutation = useLogout()

  const userInitial = initialUser.email?.charAt(0).toUpperCase() || 'U'
  const isAdmin = initialUser.role === 'admin'

  // 作图 and 生视频 share `/generate`, so the path alone cannot say which entry
  // is live — `mode` has to come in. See `resolveActiveNavKey`.
  const activeKey = resolveActiveNavKey(pathname, mode)
  const currentPageName = navLabelFor(activeKey)
  const isGenerateRoute = pathname === GENERATE_ROUTE

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

  /** Mode entries also close the drawer; the route entries do it on their Link. */
  function handleModeSelect(next: GenerateModeTab) {
    if (useGenerateUiStore.getState().isGenerating) return
    closeDrawer()
    selectMode(next)
  }

  return (
    <>
      <header className="relative z-sticky flex h-[var(--layout-header)] shrink-0 items-center border-b border-border bg-surface">
        <ContentFrame className="flex items-center gap-3">
          <Link
            href={GENERATE_ROUTE}
            className="shrink-0 rounded-control flex items-center"
            aria-label="MuseCanvas 创作台"
          >
            <BrandMark variant="wordmark" priority className="h-6 w-auto" />
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
                    {isActive ? <span aria-hidden="true" className={activeBarClass(true)} /> : null}
                    {item.label}
                  </Link>
                )
              }
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={submissionBusy}
                  title={submissionBusy ? '正在提交，请稍候再切换模式' : undefined}
                  onClick={() => handleModeSelect(item.mode)}
                  aria-current={isActive ? 'page' : undefined}
                  className={navItemClass(isActive)}
                >
                  {isActive ? <span aria-hidden="true" className={activeBarClass(true)} /> : null}
                  <Icon weight="duotone" className={iconSize.sm} aria-hidden="true" />
                  {item.label}
                </button>
              )
            })}
          </nav>

          {/* Mobile: page name */}
          <span className="min-w-0 truncate text-sm font-medium text-foreground md:hidden">{currentPageName}</span>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
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

            <nav className="mt-6 flex flex-col gap-1" aria-label="抽屉导航">
              {workspaceNavItems.map((item) => {
                const isActive = item.key === activeKey
                if (item.kind === 'route') {
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      onClick={closeDrawer}
                      aria-current={isActive ? 'page' : undefined}
                      className={navItemClass(isActive)}
                    >
                      {isActive ? <span aria-hidden="true" className={activeBarClass(false)} /> : null}
                      {item.label}
                    </Link>
                  )
                }
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={submissionBusy}
                    title={submissionBusy ? '正在提交，请稍候再切换模式' : undefined}
                    onClick={() => handleModeSelect(item.mode)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(navItemClass(isActive), 'w-full text-left')}
                  >
                    {isActive ? <span aria-hidden="true" className={activeBarClass(false)} /> : null}
                    <Icon weight="duotone" className={iconSize.sm} aria-hidden="true" />
                    {item.label}
                  </button>
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
