'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeftIcon as ArrowLeft,
  CpuIcon as Cpu,
  FileTextIcon as FileText,
  GearSixIcon as GearSix,
  HouseIcon as House,
  ImagesIcon as Images,
  ListBulletsIcon as ListBullets,
  ShieldCheckIcon as ShieldCheck,
  SidebarSimpleIcon as SidebarSimple,
  SignOutIcon as SignOut,
  UserCircleIcon as UserCircle,
  UsersIcon as Users,
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'

import { BrandMark } from '@/shared/components/brand-mark'
import {
  Avatar,
  DropdownMenu,
  ghostIconButtonVariants,
  useToast,
} from '@/shared/components/ui'
import { useAuth } from '@/shared/hooks/useAuth'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { SessionUserDto } from '@/shared/types'
import {
  ADMIN_NAV_GROUPS,
  adminBreadcrumb,
  isAdminNavActive,
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from '../lib/admin-layout'
import type { AdminNavIconKey } from '../lib/admin-layout'

/** 侧栏图标槽：lib 只给键，React 组件在这里映射，纯模块不依赖 Phosphor。 */
const NAV_ICONS: Record<AdminNavIconKey, PhosphorIcon> = {
  overview: House,
  users: Users,
  media: Images,
  language: Cpu,
  prompt: FileText,
  jobs: ListBullets,
  oauth: ShieldCheck,
  settings: GearSix,
}

const SIDEBAR_NAV_ID = 'admin-sidebar-nav'

const NAV_ITEM_BASE =
  'relative flex min-h-[var(--control-md)] items-center gap-2.5 rounded-control px-2.5 text-sm transition-colors'

export interface AdminShellProps {
  /** RSC 守卫已确认的管理员身份；只用于账户菜单展示。 */
  user: SessionUserDto
  children: ReactNode
}

/**
 * 后台外壳（画板 07）：固定侧栏 + 56px 顶栏 + 内容区。
 *
 * 侧栏 260px / 折叠 64px（`--layout-sidebar*`），折叠状态写入 localStorage：
 * 服务端与首帧一律按展开渲染（hydration 一致），挂载后再应用用户偏好。
 * 窄屏（<960px）时侧栏与内容竖向堆叠，折叠只在桌面生效，避免移动端出现
 * 只有图标的超长列表。
 */
export function AdminShell({ user, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { toast } = useToast()
  const { logout } = useAuth()

  // SSR/首帧固定展开；挂载后才读取偏好，避免 hydration 不一致。
  const [collapsed, setCollapsed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    setCollapsed(readSidebarCollapsed())
  }, [])

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      writeSidebarCollapsed(next)
      return next
    })
  }, [])

  const breadcrumb = adminBreadcrumb(pathname)

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      setLoggingOut(false)
      toast.error('退出登录失败', error instanceof Error ? error.message : '请检查网络后重试。')
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-foreground md:flex-row">
      <aside
        aria-label="管理后台"
        className={cn(
          'flex w-full shrink-0 flex-col border-b border-border bg-surface',
          'md:sticky md:top-0 md:h-dvh md:overflow-y-auto md:border-b-0 md:border-r',
          collapsed ? 'md:w-[var(--layout-sidebar-collapsed)]' : 'md:w-[var(--layout-sidebar)]',
        )}
      >
        <nav
          id={SIDEBAR_NAV_ID}
          aria-label="后台导航"
          className="flex min-h-0 flex-1 flex-col gap-1 p-3"
        >
          <div
            className={cn(
              'mb-2 flex h-11 shrink-0 items-center gap-2 px-1 text-foreground',
              collapsed ? 'justify-between md:justify-center' : 'justify-between',
            )}
          >
            <Link
              href={APP_ROUTES.admin}
              className={cn('flex min-w-0 items-center gap-2 rounded-control', collapsed && 'md:hidden')}
              aria-label="管理后台首页"
            >
              <BrandMark variant="mark" size={36} />
              <span className="truncate text-compact font-medium">管理后台</span>
            </Link>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
              aria-controls={SIDEBAR_NAV_ID}
              className={cn(
                ghostIconButtonVariants({ size: 'sm' }),
                'size-[var(--control-compact)] max-sm:size-11 max-md:hidden',
              )}
            >
              <SidebarSimple size={18} aria-hidden="true" />
            </button>
          </div>

          {ADMIN_NAV_GROUPS.map((group, groupIndex) => (
            <div
              key={group.title ?? `group-${groupIndex}`}
              className="mb-2.5 flex flex-col gap-0.5 text-foreground"
            >
              {group.title ? (
                <span
                  className={cn(
                    'px-2.5 pb-1.5 pt-3 text-compact font-semibold',
                    collapsed && 'md:hidden',
                  )}
                >
                  {group.title}
                </span>
              ) : null}
              {group.items.map((item) => {
                const Icon = NAV_ICONS[item.icon]
                const active = isAdminNavActive(pathname, item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    title={item.label}
                    className={cn(
                      NAV_ITEM_BASE,
                      collapsed ? 'justify-start md:justify-center' : 'justify-start',
                      active
                        ? 'bg-tonal-selected font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-tonal hover:text-foreground',
                    )}
                  >
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 bg-primary"
                      />
                    ) : null}
                    <Icon size={18} aria-hidden="true" className="shrink-0" />
                    <span className={cn('truncate', collapsed && 'md:hidden')}>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}

          <div className="mt-auto border-t border-border pt-3">
            <Link
              href={APP_ROUTES.generate}
              aria-label={collapsed ? '返回创作台' : undefined}
              title="返回创作台"
              className={cn(
                NAV_ITEM_BASE,
                'text-muted-foreground hover:bg-tonal hover:text-foreground',
                collapsed ? 'justify-start md:justify-center' : 'justify-start',
              )}
            >
              <ArrowLeft size={18} aria-hidden="true" className="shrink-0" />
              <span className={cn('truncate', collapsed && 'md:hidden')}>返回创作台</span>
            </Link>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[var(--layout-header)] shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6 md:px-10">
          <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-ui">
            <span className="shrink-0 text-muted-foreground">管理后台</span>
            {breadcrumb ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
                <span className="truncate text-foreground">{breadcrumb.label}</span>
              </>
            ) : null}
          </nav>

          <DropdownMenu
            menuLabel="账户菜单"
            trigger={
              <button
                type="button"
                aria-label="账户菜单"
                className="inline-flex size-[var(--control-sm)] shrink-0 items-center justify-center rounded-pill max-sm:size-11"
              >
                <Avatar size="sm" initial={user.email} decorative className="bg-tonal-selected" />
              </button>
            }
            header={
              <div className="mb-1 border-b border-border px-3 pb-2 pt-1.5">
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">管理员</p>
              </div>
            }
            items={[
              {
                id: 'account',
                label: '账户',
                icon: <UserCircle size={16} aria-hidden="true" />,
                onSelect: () => router.push(APP_ROUTES.account),
              },
              {
                id: 'logout',
                label: loggingOut ? '正在退出…' : '退出登录',
                icon: <SignOut size={16} aria-hidden="true" />,
                danger: true,
                separator: true,
                disabled: loggingOut,
                onSelect: () => {
                  void handleLogout()
                },
              },
            ]}
          />
        </header>

        <main
          id="main"
          className="flex min-w-0 flex-1 flex-col gap-7 px-4 pb-12 pt-7 sm:px-6 md:px-10"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
