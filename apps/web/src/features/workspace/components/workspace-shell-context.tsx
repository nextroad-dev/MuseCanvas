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
  /** 注册 AppShell 侧栏主导航下方的扩展内容（如 `/generate` 最近会话列表）。 */
  setSidebarSlot?: (slot: ReactNode | null) => void
  /** 注册 AppShell 顶栏右侧扩展操作区。 */
  setHeaderSlot?: (slot: ReactNode | null) => void
}

const WorkspaceShellContext = createContext<WorkspaceShellContextValue | null>(null)

export interface WorkspaceShellProviderProps {
  value: WorkspaceShellContextValue
  children: ReactNode
}

/**
 * 向工作区子视图透传当前会话、认证动作与 AppShell 插槽注册能力。
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
