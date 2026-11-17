// 后台壳的导航模型与折叠状态：纯模块（无 React、无 DOM），
// 侧栏、面包屑以及 A2/A3 的后台页面共用同一份顺序与路径，避免各自抄一份导航。

import { APP_ROUTES } from '@/shared/lib/app-routes'

/** 侧栏图标槽的键：具体图标组件由 `admin-shell.tsx` 映射，纯模块不 import Phosphor。 */
export type AdminNavIconKey =
  | 'overview'
  | 'prompt'
  | 'oauth'
  | 'settings'

export interface AdminNavItem {
  label: string
  href: string
  icon: AdminNavIconKey
}

export interface AdminNavGroup {
  /** `null` = 该组不显示标题（概览独占首组，画板 07）。 */
  title: string | null
  items: AdminNavItem[]
}

/**
 * 侧栏分组顺序：概览 / 生成资源 / 系统设置。
 * 新增后台页时只改这里，导航、面包屑与当前项高亮会一起生效。
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    title: null,
    items: [{ label: '概览', href: APP_ROUTES.admin, icon: 'overview' }],
  },
  {
    title: '生成资源',
    items: [{ label: '提示词模板', href: APP_ROUTES.adminPromptTemplates, icon: 'prompt' }],
  },
  {
    title: '系统设置',
    items: [
      { label: 'OAuth', href: APP_ROUTES.adminOAuth, icon: 'oauth' },
      { label: '系统配置', href: APP_ROUTES.adminSettings, icon: 'settings' },
    ],
  },
]

/** 折叠状态持久化键：值只写 `collapsed | expanded`，读不到即按展开处理。 */
export const ADMIN_SIDEBAR_STORAGE_KEY = 'musecanvas-admin-sidebar'

export function adminNavItems(): AdminNavItem[] {
  return ADMIN_NAV_GROUPS.flatMap((group) => group.items)
}

/**
 * 当前项判定：`/admin` 必须精确匹配，其余按路径前缀匹配，
 * 这样嵌套子路径仍高亮对应的后台导航项。
 */
export function isAdminNavActive(
  pathname: string | null | undefined,
  href: string,
): boolean {
  const path = (pathname ?? '').split('?')[0].replace(/\/+$/, '') || '/'
  const target = href.replace(/\/+$/, '') || '/'
  if (target === APP_ROUTES.admin) return path === target
  return path === target || path.startsWith(`${target}/`)
}

/** 路径 → 命中的导航项（含所属分组）；详情页按前缀归到父级入口。 */
export function adminNavMatch(
  pathname: string | null | undefined,
): { group: AdminNavGroup; item: AdminNavItem } | null {
  for (const group of ADMIN_NAV_GROUPS) {
    for (const item of group.items) {
      if (isAdminNavActive(pathname, item.href)) return { group, item }
    }
  }
  return null
}

export interface AdminBreadcrumb {
  label: string
  /** 分组标题，概览为 `null`。 */
  group: string | null
  href: string
}

/** 顶栏面包屑的「当前页」；未登记的路径返回 `null`，壳只显示「管理后台」。 */
export function adminBreadcrumb(pathname: string | null | undefined): AdminBreadcrumb | null {
  const match = adminNavMatch(pathname)
  if (!match) return null
  return { label: match.item.label, group: match.group.title, href: match.item.href }
}

/** SSR 一律返回 `false`（首屏展开），挂载后由客户端读取真实偏好。 */
export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ADMIN_SIDEBAR_STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

/** 存储失败（隐私模式 / 禁用 localStorage）只影响下次进入，当前会话仍然生效。 */
export function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ADMIN_SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    /* 忽略：折叠仍在内存状态里生效 */
  }
}
