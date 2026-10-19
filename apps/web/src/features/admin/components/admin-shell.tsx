'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { User } from '@/shared/types'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { Avatar } from '@/shared/components/ui/avatar'
import { IconButton } from '@/shared/components/ui/button'
import { useDialog } from '@/shared/hooks/useDialog'
import { cn } from '@/shared/lib/cn'
import {
  SquaresFourIcon as LayoutDashboard,
  UsersIcon as Users,
  PuzzlePieceIcon as Blocks,
  CpuIcon as Cpu,
  FileTextIcon as FileText,
  ShieldCheckIcon as ShieldCheck,
  GearSixIcon as Settings,
  ListChecksIcon as ListTodo,
  ListIcon as Menu,
  XIcon as X,
  CaretDoubleLeftIcon as CollapseSidebar,
  CaretDoubleRightIcon as ExpandSidebar,
  ArrowLeftIcon as BackToConsole,
  CaretUpDownIcon as ChevronUpDown,
} from '@phosphor-icons/react'
import { iconSize } from '@/shared/components/ui'
import {
  adminTouchTargetsSquare,
  readAdminSidebarCollapsed,
  writeAdminSidebarCollapsed,
} from '../lib/admin-layout'

interface AdminShellProps {
  user: User
  children: React.ReactNode
}

interface NavItem {
  path: string
  label: string
  icon: PhosphorIcon
}

interface NavGroup {
  /** Navigation group heading, distinct from page sections. */
  title?: string
  items: NavItem[]
}

interface Crumb {
  /** `null` marks a non-link segment (a navigation group heading, not a page). */
  href: string | null
  label: string
}

/** Non-link group segment inserted before a page that sits under a titled nav group. */
const CRUMB_GROUP_BEFORE: Record<string, string> = { '/admin/media-models': '生成资源' }

/**
 * Jude-Frontweb admin layout (foundations.md 管理后台布局): sidebar 260px
 * (`--layout-sidebar`) + 56px header (`--layout-header`) + a `max-w-content`
 * content area. The sidebar becomes an overlay drawer below the 960px (`md`)
 * threshold.
 */
const SIDEBAR_BREAKPOINT_QUERY = '(min-width: 960px)'

const navGroups: NavGroup[] = [
  { items: [{ path: '/admin', label: '概览', icon: LayoutDashboard }] },
  {
    title: '用户与权限',
    items: [{ path: '/admin/users', label: '用户管理', icon: Users }],
  },
  {
    title: '生成资源',
    items: [
      { path: '/admin/media-models', label: '媒体模型', icon: Blocks },
      { path: '/admin/language-models', label: '语言模型', icon: Cpu },
      { path: '/admin/prompt-templates', label: '提示词模板', icon: FileText },
    ],
  },
  {
    title: '运行',
    items: [{ path: '/admin/jobs', label: '任务监控', icon: ListTodo }],
  },
  {
    title: '系统设置',
    items: [
      { path: '/admin/oauth', label: 'OAuth', icon: ShieldCheck },
      { path: '/admin/settings', label: '系统配置', icon: Settings },
    ],
  },
]

/** path → visible label, shared by the nav and the breadcrumb. */
const NAV_LABELS: Record<string, string> = { '/admin': '管理后台' }
for (const group of navGroups) {
  for (const item of group.items) NAV_LABELS[item.path] = item.label
}

/**
 * Pathname-driven breadcrumb. The root crumb is always 管理后台; each further
 * segment resolves through `NAV_LABELS` and falls back to the raw segment, so a
 * route the nav does not list is still described truthfully.
 */
function buildCrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ href: '/admin', label: NAV_LABELS['/admin'] }]
  const [, ...rest] = pathname.split('/').filter(Boolean)
  let href = ''
  for (const segment of rest) {
    href = `${href}/${segment}`
    const path = `/admin${href}`
    const group = CRUMB_GROUP_BEFORE[path]
    if (group) crumbs.push({ href: null, label: group })
    crumbs.push({ href: path, label: NAV_LABELS[path] ?? segment })
  }
  return crumbs
}

function Breadcrumbs({ pathname }: { pathname: string }) {
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname])
  // Middle crumbs are the ones that drop on a narrow header; the current page never does.
  const hasMiddle = crumbs.length > 2

  return (
    <nav aria-label="面包屑" className="min-w-0 flex-1 md:flex-none">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          const isMiddle = index > 0 && !isLast
          return (
            <li
              key={crumb.href ?? `group-${crumb.label}`}
              className={cn('flex min-w-0 items-center gap-1.5', isMiddle && 'hidden md:flex')}
            >
              {index > 0 ? (
                <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                  /
                </span>
              ) : null}
              {isLast ? (
                <span aria-current="page" className="truncate font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : crumb.href === null ? (
                <span className="truncate text-muted-foreground">{crumb.label}</span>
              ) : (
                <Link
                  href={crumb.href}
                  className="truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          )
        })}
        {hasMiddle ? (
          // Ellipsis stands in for the collapsed middle section on narrow viewports.
          <li aria-hidden="true" className="shrink-0 text-muted-foreground md:hidden">
            …
          </li>
        ) : null}
      </ol>
    </nav>
  )
}

export function AdminShell({ user, children }: AdminShellProps) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // First paint always renders expanded (SSR-safe); the stored choice is
  // applied after mount, so a refresh keeps the operator's collapse state.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(readAdminSidebarCollapsed())
  }, [])
  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      writeAdminSidebarCollapsed(next)
      return next
    })
  }, [])
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
  useEffect(() => {
    closeDrawer()
  }, [pathname, closeDrawer])

  useEffect(() => {
    const breakpoint = window.matchMedia(SIDEBAR_BREAKPOINT_QUERY)
    const closeOnDesktop = () => {
      if (breakpoint.matches) closeDrawer()
    }
    breakpoint.addEventListener('change', closeOnDesktop)
    return () => breakpoint.removeEventListener('change', closeOnDesktop)
  }, [closeDrawer])

  const userInitial = user.email?.charAt(0).toUpperCase() || 'A'

  function isItemActive(itemPath: string) {
    if (itemPath === '/admin') {
      return pathname === '/admin'
    }
    const cleanPath = itemPath.split('?')[0]
    return pathname.startsWith(cleanPath)
  }

  /**
   * Sidebar link list. In the collapsed desktop rail only the glyphs show, so
   * each item carries its name as `aria-label` + `title`; expanded items (and
   * the mobile drawer, which always renders expanded) get their name from the
   * visible text instead. Group headings are hidden while collapsed.
   */
  const renderNavLinks = (isCollapsed: boolean, options?: { onNavigate?: () => void }) => {
    const { onNavigate } = options ?? {}
    return (
      <div className="flex flex-col gap-2.5">
        {navGroups.map((group, groupIndex) => (
          <div key={group.title ?? groupIndex} className="flex flex-col gap-0.5">
            {group.title && !isCollapsed && (
              <h2 className="px-3 py-1 text-overline text-muted-foreground">
                {group.title}
              </h2>
            )}
            {group.items.map((item) => {
              const active = isItemActive(item.path)
              const Icon = item.icon
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  aria-label={isCollapsed ? item.label : undefined}
                  title={isCollapsed ? item.label : undefined}
                  className={cn(
                    'relative flex min-h-10 items-center gap-3 rounded-control py-1.5',
                    'text-sm transition-colors',
                    active && 'font-medium',
                    isCollapsed ? 'justify-center px-2' : 'px-3',
                    active
                      ? 'bg-tonal-selected text-foreground'
                      : 'text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
                  )}
                >
                  {active ? (
                    // Active marker: a 3px rule on the leading edge, inset from the corners.
                    <span aria-hidden="true" className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-pill bg-foreground" />
                  ) : null}
                  <Icon weight="duotone" className={`${iconSize.sm} shrink-0`} aria-hidden="true" />
                  {isCollapsed ? null : <span className="truncate">{item.label}</span>}
                </Link>
              )
            })}
          </div>
        ))}
      </div>
    )
  }

  const renderBackToConsole = (isCollapsed: boolean) => (
    <Link
      href="/generate"
      aria-label={isCollapsed ? '返回创作台' : undefined}
      title={isCollapsed ? '返回创作台' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-control py-2 text-sm font-medium text-muted-foreground transition-colors',
        'hover:bg-tonal-hover hover:text-foreground',
        isCollapsed ? 'justify-center px-2' : 'px-3',
      )}
    >
      <BackToConsole weight="bold" className={`${iconSize.sm} shrink-0`} aria-hidden="true" />
      {isCollapsed ? null : <span className="truncate">返回创作台</span>}
    </Link>
  )

  const renderUserFooter = (isCollapsed: boolean) => (
    <div
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-control py-2 transition-colors',
        'hover:bg-tonal-hover',
        isCollapsed ? 'justify-center px-2' : 'px-3',
      )}
      aria-label={isCollapsed ? user.email : undefined}
      title={isCollapsed ? user.email : undefined}
    >
      <Avatar size="sm" initial={userInitial} decorative />
      {isCollapsed ? null : (
        <>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{user.email}</span>
            <span className="truncate text-caption text-muted-foreground">管理员</span>
          </div>
          <ChevronUpDown weight="bold" className={`${iconSize.sm} shrink-0 text-muted-foreground`} aria-hidden="true" />
        </>
      )}
    </div>
  )

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-canvas text-foreground">
      {/* Header — 56px (`--layout-header`), strictly aligned with workspace header */}
      <header className="relative z-sticky flex h-[var(--layout-header)] shrink-0 items-center border-b border-border bg-canvas">
        <ContentFrame className="flex min-w-0 items-center gap-2 sm:gap-4">
          <IconButton
            variant="ghost"
            size="sm"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开管理导航"
            className="min-h-[var(--control-lg)] min-w-[var(--control-lg)] md:hidden"
            icon={<Menu weight="bold" className={iconSize.md} aria-hidden="true" />}
          />

          <Breadcrumbs pathname={pathname} />

          <div className={cn('ml-auto flex shrink-0 items-center gap-2 sm:gap-3', adminTouchTargetsSquare)}>
            <ThemeToggle />
          </div>
        </ContentFrame>
      </header>

      {/* Header and shell share one border-box frame; main owns only vertical padding. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ContentFrame className="flex min-h-0 flex-1 gap-6 overflow-hidden">
          {/* Sidebar — 260px `--layout-sidebar` wide, 64px (`w-sidebar-collapsed`)
              icon rail while collapsed. A hairline rule divides it from the
              content; it is navigation, not a floating card. Below `md` it is
              replaced by the overlay drawer, so the collapsed width can never
              cover content on a 375px viewport. */}
          <aside className={cn('hidden shrink-0 flex-col border-r border-border py-6 transition-[width] md:flex', collapsed ? 'w-sidebar-collapsed' : 'w-sidebar')}>
            <div className={cn('mb-6 flex items-center gap-2', collapsed ? 'justify-center px-2' : 'justify-between px-3')}>
              {/* Collapsed rail keeps only the toggle: the brand link would be an unlabelled glyph. */}
              {collapsed ? null : (
                <Link
                  href="/admin"
                  className="inline-flex min-w-0 items-center gap-2.5 rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
                  aria-label="管理后台首页"
                >
                  <BrandMark variant="mark" className="h-5" />
                  <span className="truncate text-base font-medium text-foreground">管理后台</span>
                </Link>
              )}
              <IconButton
                variant="ghost"
                size="sm"
                onClick={toggleSidebar}
                aria-expanded={!collapsed}
                aria-controls="admin-sidebar-nav"
                aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
                title={collapsed ? '展开侧栏' : '收起侧栏'}
                icon={collapsed
                  ? <ExpandSidebar weight="bold" className={iconSize.md} aria-hidden="true" />
                  : <CollapseSidebar weight="bold" className={iconSize.md} aria-hidden="true" />}
              />
            </div>
            <nav id="admin-sidebar-nav" className={cn('flex w-full flex-1 flex-col overflow-hidden', collapsed ? 'px-2' : 'px-3')} aria-label="管理后台导航">
              <div className="min-h-0 flex-1 overflow-y-auto">{renderNavLinks(collapsed)}</div>
            </nav>
            <div className={cn('mt-6 border-t border-border pt-3', collapsed ? 'px-2' : 'px-3')}>
              {renderUserFooter(collapsed)}
              {renderBackToConsole(collapsed)}
            </div>
          </aside>

          <main className="@container/admin min-h-0 min-w-0 flex-1 overflow-y-auto py-6 md:py-8">
            {children}
          </main>
        </ContentFrame>
      </div>

      {/* Narrow-viewport (`max-md`) overlay drawer */}
      {drawerMounted && drawerPortalTarget && createPortal(
        <div
          {...drawerRootProps}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDrawer()
          }}
          className={cn(
            'fixed inset-0 z-overlay md:hidden',
            drawerPhase === 'close' ? 'motion-fade-out pointer-events-none' : 'motion-fade-in',
          )}
        >
          <div
            className="fixed inset-0"
            style={{ backgroundColor: 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)' }}
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <div
            {...drawerDialogProps}
            className={cn(
              'fixed inset-y-0 left-0 z-modal flex h-dvh w-full max-w-sidebar min-w-0 flex-col gap-4 bg-surface p-4 shadow-drawer',
              drawerPhase === 'close' ? 'motion-drawer-out-left' : 'motion-drawer-in-left',
            )}
          >
            {/* Dialog-class surface: no rule inside the panel, spacing does the work. */}
            <div className="flex items-center justify-between gap-3">
              <h2 id={drawerLabelId} className="text-module text-foreground">
                管理后台导航
              </h2>
              <IconButton
                ref={drawerCloseButtonRef}
                variant="ghost"
                size="sm"
                onClick={closeDrawer}
                aria-label="关闭导航"
                className="min-h-[var(--control-lg)] min-w-[var(--control-lg)]"
                icon={<X weight="bold" className={iconSize.md} aria-hidden="true" />}
              />
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="管理后台导航">
              {renderNavLinks(false, { onNavigate: closeDrawer })}
            </nav>
            <div className="border-t border-border pt-3">
              {renderUserFooter(false)}
              {renderBackToConsole(false)}
            </div>
          </div>
        </div>,
        drawerPortalTarget,
      )}
    </div>
  )
}
