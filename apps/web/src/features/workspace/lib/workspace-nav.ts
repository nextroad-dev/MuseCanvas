import { GENERATE_ROUTE, LIBRARY_ROUTE, isOnGenerate } from '@/shared/lib/app-routes'
import type { GenerateModeTab } from '@/shared/types'

/**
 * The workspace top navigation: two real routes, 创作 (`/generate`) and 图库
 * (`/library`). Output type (image / video) is no longer a nav-level mode — it
 * follows the model picked in the creation console — so both entries are plain
 * links. The desktop segmented control, the mobile drawer and the `<md` page
 * name all render from this one table and cannot drift apart.
 */
export type WorkspaceNavKey = 'create' | 'library'

export type WorkspaceNavItem = {
  key: WorkspaceNavKey
  kind: 'route'
  label: string
  href: string
}

/** Route literals the header's account cluster points at. They live next to the
 *  nav table so the header owns no loose paths of its own. */
export const ACCOUNT_ROUTE = '/account'
export const ADMIN_ROUTE = '/admin'

export const workspaceNavItems: WorkspaceNavItem[] = [
  { key: 'create', kind: 'route', href: GENERATE_ROUTE, label: '创作' },
  { key: 'library', kind: 'route', href: LIBRARY_ROUTE, label: '图库' },
]

/**
 * Which nav entry is live, from the pathname alone.
 *
 * `mode` is kept as an accepted-but-ignored second parameter so existing
 * two-argument callers (`resolveActiveNavKey(pathname, mode)`) keep compiling
 * during the migration; it no longer influences the result because both
 * creation modes share `/generate`.
 */
export function resolveActiveNavKey(
  pathname: string,
  // Accepted-but-ignored: keeps two-argument callers compiling during migration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mode?: GenerateModeTab,
): WorkspaceNavKey | undefined {
  if (isOnGenerate(pathname)) return 'create'
  if (pathname === LIBRARY_ROUTE || pathname.startsWith(`${LIBRARY_ROUTE}/`)) return 'library'
  return undefined
}

export function navLabelFor(key: WorkspaceNavKey | undefined): string {
  return workspaceNavItems.find((item) => item.key === key)?.label ?? ''
}
