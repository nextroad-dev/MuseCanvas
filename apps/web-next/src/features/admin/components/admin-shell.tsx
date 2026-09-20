'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { User } from '@/shared/types'
import {
  LayoutDashboard,
  Users,
  Cpu,
  Key,
  FileText,
  Coins,
  ShieldCheck,
  Settings,
  ListTodo,
  ArrowLeft,
  Menu,
  X,
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

const navGroups: NavGroup[] = [
  { items: [{ path: '/admin', label: '概览', icon: LayoutDashboard }] },
  {
    title: '用户与权限',
    items: [{ path: '/admin/users', label: '用户管理', icon: Users }],
  },
  {
    title: '生成资源',
    items: [
      { path: '/admin/models', label: '模型管理', icon: Cpu },
      { path: '/admin/providers', label: '供应商凭据', icon: Key },
      { path: '/admin/prompt-templates', label: '提示词模板', icon: FileText },
    ],
  },
  {
    title: '系统设置',
    items: [
      { path: '/admin/billing', label: '计费设置', icon: Coins },
      { path: '/admin/oauth', label: 'OAuth', icon: ShieldCheck },
      { path: '/setup?step=site', label: '系统配置', icon: Settings },
    ],
  },
  { items: [{ path: '/admin/jobs', label: '任务监控', icon: ListTodo }] },
]

export function AdminShell({ user, children }: AdminShellProps) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)

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
            <h2 className="px-3 py-1 text-xs font-medium text-muted-foreground">
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
                className={`flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-surface-subtle text-foreground'
                    : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      {/* Top bar */}
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <Link
          href="/generate"
          className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle-strong"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回创作端
        </Link>

        <span className="hidden text-sm font-medium text-foreground md:inline">管理后台</span>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{user.email}</span>
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-subtle text-sm font-medium text-foreground"
            title={user.email}
          >
            {userInitial}
          </div>

          {/* Mobile menu button */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:hidden"
            aria-label="打开管理导航"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop Sidebar */}
        <aside className="hidden w-60 shrink-0 border-r border-border bg-surface py-3 md:flex">
          <nav className="flex w-full flex-col px-2" aria-label="管理后台导航">
            {renderNavLinks()}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto p-4 sm:p-6">{children}</main>
      </div>

      {/* Mobile Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 flex w-full max-w-xs flex-col bg-surface p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <span className="font-medium text-foreground">管理后台导航</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-[var(--radius-control)] p-1 text-muted-foreground hover:text-foreground"
                aria-label="关闭"
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
