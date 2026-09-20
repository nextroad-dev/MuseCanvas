import type { LucideIcon } from 'lucide-react'
import { Image as ImageIcon, Video } from 'lucide-react'
import type { GenerateModeTab } from '@/shared/types'
import { LIBRARY_ROUTE, isOnGenerate } from '@/shared/lib/app-routes'

/**
 * One navigation bar drives two different things now: the creation *mode*
 * (作图 / 生视频, both living on `/generate`) and a real route (图库). Keeping
 * them in a single array is what stops the desktop nav, the mobile drawer and
 * the `<md` page name from drifting apart.
 */
export type WorkspaceNavKey = GenerateModeTab | 'library'

export type WorkspaceNavItem =
  | {
      key: GenerateModeTab
      kind: 'mode'
      label: string
      /** Same value as `key`; lets a renderer branch on `kind` without casting. */
      mode: GenerateModeTab
      icon: LucideIcon
    }
  | {
      key: 'library'
      kind: 'route'
      label: string
      href: string
    }

export const workspaceNavItems: WorkspaceNavItem[] = [
  { key: 'image', kind: 'mode', mode: 'image', label: '作图', icon: ImageIcon },
  { key: 'video', kind: 'mode', mode: 'video', label: '生视频', icon: Video },
  { key: 'library', kind: 'route', href: LIBRARY_ROUTE, label: '图库' },
]

/**
 * Which nav entry is live.
 *
 * `pathname.startsWith` alone can no longer answer this: 作图 and 生视频 share
 * `/generate`, so a path-only lookup always resolves to whichever entry sits
 * first in the array and the mobile page name would stick on 作图. The mode is
 * therefore an input, read from the store that owns it.
 */
export function resolveActiveNavKey(
  pathname: string,
  mode: GenerateModeTab,
): WorkspaceNavKey | undefined {
  if (isOnGenerate(pathname)) return mode
  if (pathname === LIBRARY_ROUTE || pathname.startsWith(`${LIBRARY_ROUTE}/`)) return 'library'
  return undefined
}

export function navLabelFor(key: WorkspaceNavKey | undefined): string {
  return workspaceNavItems.find((item) => item.key === key)?.label ?? ''
}
