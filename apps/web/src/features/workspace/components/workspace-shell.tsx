'use client'

import { useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { useAuth } from '@/shared/hooks/useAuth'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import type { SessionUserDto } from '@/shared/types'
import { WorkspaceJobObserver } from './workspace-job-observer'
import { WorkspaceShellProvider } from './workspace-shell-context'

export interface WorkspaceShellProps {
  mode: WorkspaceMode
  user: SessionUserDto | null
  /** Full-bleed console layout without boxed padding; defaults to true on `/generate` and `/library`. */
  fullBleed?: boolean
  children: ReactNode
}

function isPathMatch(pathname: string, prefix?: string): boolean {
  if (!prefix) return false
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * Headerless workspace shell for studio & account routes.
 * Passes session/auth state via WorkspaceShellProvider; studio routes (`/generate`, `/library`)
 * fill `h-dvh overflow-hidden` directly while `/account` uses centered content padding.
 */
export function WorkspaceShell({ mode, user, fullBleed, children }: WorkspaceShellProps) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const isFullConsole =
    fullBleed ??
    (isPathMatch(pathname, APP_ROUTES.generate) || isPathMatch(pathname, APP_ROUTES.library))

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await logout()
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      setLoggingOut(false)
      setLogoutError(error instanceof Error ? error.message : '请检查网络后重试。')
    }
  }

  return (
    <WorkspaceShellProvider
      value={{
        mode,
        user,
        loggingOut,
        logoutError,
        onLogout: handleLogout,
        onDismissLogoutError: () => setLogoutError(null),
      }}
    >
      <div
        className={cn(
          'flex flex-col bg-canvas text-foreground',
          isFullConsole ? 'h-dvh overflow-hidden' : 'min-h-dvh',
        )}
      >
        <WorkspaceJobObserver />
        <a
          href="#workspace-main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-toast focus:rounded-control focus:bg-surface focus:px-4 focus:py-3 focus:shadow-floating"
        >
          跳到工作区内容
        </a>

        <main
          id="workspace-main"
          tabIndex={-1}
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col outline-none',
            isFullConsole
              ? 'w-full overflow-hidden'
              : 'mx-auto w-full max-w-[var(--container-content)] px-4 py-6 md:px-8 md:py-8',
          )}
        >
          {children}
        </main>
      </div>
    </WorkspaceShellProvider>
  )
}
