'use client'

// Agent Console 易失 UI 状态（仅客户端面板开关、当前选中会话/产物与输入草稿）。
// 服务端会话、时间线、工具与审批状态一律由 TanStack Query + useAgentConsole 托管。

import { create } from 'zustand'
import type { WorkspaceInspectorTab } from '@/shared/lib/app-routes'
import { consumeReuseQuery } from '../lib/agent-console-reuse'

export interface AgentDefinitionDraft {
  agentDefinitionId: string
  definitionVersion: number
}

export interface AgentConsoleUiState {
  activeSessionId: string | null
  leftSidebarOpen: boolean
  rightPanelOpen: boolean
  rightPanelTab: WorkspaceInspectorTab
  draftPrompt: string
  lastReuseQuery: string
  definitionDraft: AgentDefinitionDraft

  setActiveSessionId: (sessionId: string | null) => void
  toggleLeftSidebar: () => void
  setLeftSidebarOpen: (open: boolean) => void
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: WorkspaceInspectorTab) => void
  setDraftPrompt: (prompt: string) => void
  consumeReuseQuery: (query: string) => void
  setDefinitionDraft: (patch: Partial<AgentDefinitionDraft>) => void
  resetForActor: () => void
}

function defaultDefinitionDraft(): AgentDefinitionDraft {
  return {
    agentDefinitionId: '',
    definitionVersion: 1,
  }
}

export const useAgentConsoleStore = create<AgentConsoleUiState>((set) => ({
  activeSessionId: null,
  leftSidebarOpen: true,
  rightPanelOpen: false,
  rightPanelTab: 'artifacts',
  draftPrompt: '',
  lastReuseQuery: '',
  definitionDraft: defaultDefinitionDraft(),

  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  toggleLeftSidebar: () => set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen })),
  setLeftSidebarOpen: (leftSidebarOpen) => set({ leftSidebarOpen }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  setDraftPrompt: (draftPrompt) => set({ draftPrompt }),
  consumeReuseQuery: (query) => set((state) => consumeReuseQuery(state, query)),
  setDefinitionDraft: (patch) =>
    set((state) => ({
      definitionDraft: {
        ...state.definitionDraft,
        ...patch,
      },
    })),
  resetForActor: () =>
    set({
      activeSessionId: null,
      draftPrompt: '',
      lastReuseQuery: '',
      definitionDraft: defaultDefinitionDraft(),
    }),
}))
