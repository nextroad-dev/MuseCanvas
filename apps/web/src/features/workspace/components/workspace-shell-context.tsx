'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import type { SessionUserDto } from '@/shared/types'

export interface WorkspaceShellContextValue {
  mode: WorkspaceMode
  user: SessionUserDto | null
  loggingOut: boolean
  logoutError: string | null
  onLogout: () => void | Promise<void>
  onDismissLogoutError: () => void
}

const WorkspaceShellContext = createContext<WorkspaceShellContextValue | null>(null)

export interface WorkspaceShellProviderProps {
  value: WorkspaceShellContextValue
  children: ReactNode
}

/**
 * 向全屏沉浸控制台等无顶栏页面透传当前会话与认证动作。
 * 独立单元渲染时可能不在 WorkspaceShell 内，消费方需兼容返回 null 的情况。
 */
export function WorkspaceShellProvider({ value, children }: WorkspaceShellProviderProps) {
  return (
    <WorkspaceShellContext.Provider value={value}>
      {children}
    </WorkspaceShellContext.Provider>
  )
}

export function useWorkspaceShell(): WorkspaceShellContextValue | null {
  return useContext(WorkspaceShellContext)
}
