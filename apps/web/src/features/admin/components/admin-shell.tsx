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
} from '@phosphor-icons/react'
import { iconSize } from '@/shared/components/ui'
import { adminTouchTargetsSquare } from '../lib/admin-layout'

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
  href: string
  label: string
}

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
    title: '系统设置',
    items: [
      { path: '/admin/oauth', label: 'OAuth', icon: ShieldCheck },
      { path: '/admin/settings', label: '系统配置', icon: Settings },
    ],
  },
  { items: [{ path: '/admin/jobs', label: '任务监控', icon: ListTodo }] },
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
    crumbs.push({ href: `/admin${href}`, label: NAV_LABELS[`/admin${href}`] ?? segment })
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
              key={crumb.href}
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

  const renderNavLinks = (options?: { onNavigate?: () => void }) => {
    const { onNavigate } = options ?? {}
    return (
      <div className="flex flex-col gap-6">
        {navGroups.map((group, groupIndex) => (
          <div key={group.title ?? groupIndex} className="flex flex-col gap-1">
            {group.title && (
              <h2 className="mb-2 px-3 text-xs font-medium text-muted-foreground">
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
                  className={cn(
                    'relative flex min-h-[var(--control-lg)] items-center gap-3 rounded-control md:min-h-[var(--control-md)]',
                    'px-3 text-sm font-medium transition-colors',
                    active
                      ? 'bg-tonal-selected text-foreground'
                      : 'text-muted-foreground hover:bg-tonal-hover hover:text-foreground',
                  )}
                >
                  {active ? (
                    // Current page = tonal-selected + the 3px primary bar. Never brand green.
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1.5 left-0 w-[3px] rounded-pill bg-primary"
                    />
                  ) : null}
                  <Icon weight="duotone" className={`${iconSize.sm} shrink-0`} aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-canvas text-foreground">
      {/* Header — 56px (`--layout-header`), strictly aligned with workspace header */}
      <header className="relative z-sticky flex h-[var(--layout-header)] shrink-0 items-center border-b border-border bg-surface">
        <ContentFrame className="flex min-w-0 items-center gap-2 sm:gap-4">
          <IconButton
            variant="ghost"
            size="sm"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开管理导航"
            className="min-h-[var(--control-lg)] min-w-[var(--control-lg)] md:hidden"
            icon={<Menu weight="bold" className={iconSize.md} aria-hidden="true" />}
          />

          <Link
            href="/generate"
            aria-label="返回创作端"
            className="inline-flex shrink-0 items-center rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            <BrandMark priority className="max-sm:[&_img]:h-5 max-sm:[&_img]:max-w-24" />
          </Link>

          <Breadcrumbs pathname={pathname} />

          <div className={cn('ml-auto flex shrink-0 items-center gap-2 sm:gap-3', adminTouchTargetsSquare)}>
            <ThemeToggle />
            <span className="hidden max-w-48 truncate text-sm text-muted-foreground lg:inline">{user.email}</span>
            {/* Decorative: the address next to it is the label, so the letter glyph
                must not be announced a second time. */}
            <span className="hidden sm:inline"><Avatar size="sm" initial={userInitial} decorative /></span>
          </div>
        </ContentFrame>
      </header>

      {/* Header and shell share one border-box frame; main owns only vertical padding. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ContentFrame className="flex min-h-0 flex-1 gap-6 overflow-hidden">
          {/* Sidebar — fixed at the 260px `--layout-sidebar` width on desktop. A hairline
              rule divides it from the content; it is navigation, not a floating card. */}
          <aside className="hidden w-sidebar shrink-0 flex-col border-r border-border py-6 md:flex">
            <div className="mb-6 flex flex-col gap-1 px-3"><p className="text-module">管理工作台</p><p className="text-xs text-muted-foreground">资源、成员与实例状态</p></div>
            <nav className="flex w-full flex-1 flex-col overflow-hidden px-3" aria-label="管理后台导航">
              <div className="min-h-0 flex-1 overflow-y-auto">{renderNavLinks()}</div>
            </nav>
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
              {renderNavLinks({ onNavigate: closeDrawer })}
            </nav>
          </div>
        </div>,
        drawerPortalTarget,
      )}
    </div>
  )
}
