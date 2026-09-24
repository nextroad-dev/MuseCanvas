'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { User } from '@/shared/types'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import {
  LayoutDashboard,
  Users,
  Blocks,
  Cpu,
  FileText,
  ShieldCheck,
  Settings,
  ListTodo,
  ArrowLeft,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'

interface AdminShellProps {
  user: User
  children: React.ReactNode
}

interface NavItem {
  path: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavGroup {
  title?: string
  items: NavItem[]
}

/** Jude-Frontweb admin layout: 260px sidebar, collapsible to 64px icon rail. */
const SIDEBAR_EXPANDED = 260
const SIDEBAR_COLLAPSED = 64
/** Sidebar becomes an overlay drawer below this width. */
const SIDEBAR_BREAKPOINT = 'lg'
const COLLAPSE_STORAGE_KEY = 'muse-admin-sidebar-collapsed'

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

export function AdminShell({ user, children }: AdminShellProps) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Collapse preference is read post-mount only: the server has no localStorage,
  // and a first-paint mismatch would flash the wrong width and shift layout.
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1')
    } catch {
      // Storage unavailable — stay expanded.
    }
  }, [])

  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, prev ? '0' : '1')
      } catch {
        // Session-only toggle.
      }
      return !prev
    })
  }

  const userInitial = user.email?.charAt(0).toUpperCase() || 'A'

  function isItemActive(itemPath: string) {
    if (itemPath === '/admin') {
      return pathname === '/admin'
    }
    const cleanPath = itemPath.split('?')[0]
    return pathname.startsWith(cleanPath)
  }

  const renderNavLinks = (onNavigate?: () => void) => (
    <div className="flex flex-col gap-4">
      {navGroups.map((group, idx) => (
        <div key={group.title || idx} className="flex flex-col gap-0.5">
          {group.title && (
            // Overline group title; hidden on the collapsed icon rail.
            <h2
              className={`px-3 py-1 text-[11px] font-medium leading-[1.4] tracking-[0.06em] text-muted-foreground ${
                collapsed && !onNavigate ? 'sr-only' : ''
              }`}
            >
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
                title={collapsed && !onNavigate ? item.label : undefined}
                className={`flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
                  collapsed && !onNavigate ? 'justify-center px-0' : ''
                } ${
                  active
                    ? 'bg-surface-subtle text-foreground shadow-[inset_3px_0_0_var(--color-primary)]'
                    : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={collapsed && !onNavigate ? 'sr-only' : 'truncate'}>{item.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      {/* Top bar — 56px per the admin layout spec */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <Link
          href="/generate"
          className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle-strong"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回创作端
        </Link>

        <span className="hidden text-sm font-medium text-foreground md:inline">管理后台</span>

        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <span className="hidden text-xs text-muted-foreground sm:inline">{user.email}</span>
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-subtle text-sm font-medium text-foreground"
            aria-label={`当前用户 ${user.email}`}
          >
            {userInitial}
          </div>

          {/* Mobile / narrow menu button */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground lg:hidden"
            aria-label="打开管理导航"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop Sidebar — 260px expanded, 64px icon rail, overlay drawer below lg */}
        <aside
          className={`hidden shrink-0 border-r border-border bg-surface py-3 transition-[width] duration-200 ease-standard ${SIDEBAR_BREAKPOINT}:flex`}
          style={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
        >
          <nav className="flex w-full flex-col px-2" aria-label="管理后台导航">
            <div className="flex-1 overflow-auto">{renderNavLinks()}</div>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开导航栏' : '折叠导航栏'}
              aria-pressed={collapsed}
              className="mt-2 flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] px-3 text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              {!collapsed && <span className="text-sm font-medium">折叠</span>}
            </button>
          </nav>
        </aside>

        {/* Main content — capped reading width per the admin layout spec */}
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-[1200px] p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>

      {/* Narrow-viewport Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[var(--z-index-overlay)] lg:hidden">
          <div
            className="fixed inset-0 bg-overlay/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="motion-drawer-in fixed inset-y-0 left-0 z-[var(--z-index-overlay)] flex w-full max-w-xs flex-col bg-surface p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <span className="font-medium text-foreground">管理后台导航</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-[var(--radius-control)] p-1 text-muted-foreground hover:text-foreground"
                aria-label="关闭导航"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="mt-4 flex-1 overflow-auto">
              {renderNavLinks(() => setDrawerOpen(false))}
            </nav>
          </div>
        </div>
      )}
    </div>
  )
}
