'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { AppShell } from '@/shared/components/shells'
import { useAuth } from '@/shared/hooks/useAuth'
import { APP_ROUTES, isOnGenerate } from '@/shared/lib/app-routes'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import type { SessionUserDto } from '@/shared/types'
import { WorkspaceJobObserver } from './workspace-job-observer'
import { WorkspaceShellProvider, type WorkspaceShellContextValue } from './workspace-shell-context'

export interface WorkspaceShellProps {
  mode: WorkspaceMode
  user: SessionUserDto | null
  /** Full-bleed console layout without boxed padding; defaults to true on `/generate` and false on `/library`. */
  fullBleed?: boolean
  children: ReactNode
}

function isPathMatch(pathname: string, prefix?: string): boolean {
  if (!prefix) return false
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * 统一工作区外壳：基于 `AppShell` 统一 `/generate` 与 `/library` 的侧栏、顶栏、主题与退出登录，
 * 并通过 `WorkspaceShellProvider` 向 `/generate` 暴露 `sidebarSlot` / `headerSlot` 插槽注册能力。
 */
export function WorkspaceShell({ mode, user, fullBleed, children }: WorkspaceShellProps) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [sidebarSlot, setSidebarSlot] = useState<ReactNode | null>(null)
  const [headerSlot, setHeaderSlot] = useState<ReactNode | null>(null)
  const loggingOutRef = useRef(false)

  const onGenerate = isOnGenerate(pathname)
  const onLibrary = isPathMatch(pathname, APP_ROUTES.library)
  const resolvedFullBleed = fullBleed ?? onGenerate
  const headerTitle = onGenerate ? '创作台' : onLibrary ? '作品图库' : undefined

  const handleLogout = useCallback(async () => {
    if (loggingOutRef.current) return
    loggingOutRef.current = true
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await logout()
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      loggingOutRef.current = false
      setLoggingOut(false)
      setLogoutError(error instanceof Error ? error.message : '请检查网络后重试。')
    }
  }, [logout, router])

  const handleDismissLogoutError = useCallback(() => {
    setLogoutError(null)
  }, [])

  // 稳定 context 引用，避免子视图更新 sidebarSlot/headerSlot 时触发自身重渲染循环。
  const contextCacheRef = useRef<{ deps: unknown[]; value: WorkspaceShellContextValue } | null>(null)
  const contextDeps = [mode, user, loggingOut, logoutError, handleLogout, handleDismissLogoutError]
  if (
    !contextCacheRef.current ||
    contextDeps.some((dep, index) => !Object.is(dep, contextCacheRef.current!.deps[index]))
  ) {
    contextCacheRef.current = {
      deps: contextDeps,
      value: {
        mode,
        user,
        loggingOut,
        logoutError,
        onLogout: handleLogout,
        onDismissLogoutError: handleDismissLogoutError,
        setSidebarSlot,
        setHeaderSlot,
      },
    }
  }

  return (
    <WorkspaceShellProvider value={contextCacheRef.current.value}>
      <WorkspaceJobObserver />
      <AppShell
        mode={mode}
        user={user}
        fullBleed={resolvedFullBleed}
        hideHeader={onGenerate}
        headerTitle={headerTitle}
        sidebarSlot={onGenerate ? sidebarSlot : null}
        headerSlot={onGenerate ? headerSlot : null}
      >
        {children}
      </AppShell>
    </WorkspaceShellProvider>
  )
}
