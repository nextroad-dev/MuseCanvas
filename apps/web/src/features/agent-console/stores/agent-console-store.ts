'use client'

// Agent Console 易失 UI 状态（仅客户端面板开关、当前选中会话/产物、输入草稿、参考图附件与本地会话元数据）。
// 服务端会话、时间线、工具与审批状态一律由 TanStack Query + useAgentConsole 托管。

import { create } from 'zustand'
import type { WorkspaceInspectorTab } from '@/shared/lib/app-routes'
import { consumeReuseQuery } from '../lib/agent-console-reuse'

const SESSION_META_STORAGE_KEY = 'muse.console.session-meta.v1'
export const MAX_DRAFT_ATTACHMENTS = 4

export const SEED_SESSION_DEFAULT_TITLES: Record<string, string> = {
  '00000000-0000-4000-8000-000000000401': '晨雾水乡乌篷船写意参考样片',
}

export interface ReferenceImageAttachment {
  id: string
  url: string
  name: string
  mimeType?: string
  width?: number
  height?: number
  sizeBytes?: number
  source: 'upload' | 'library' | 'artifact'
  assetId?: string
  uploadId?: string
  checksum?: string
  /** 局部修改准备身份：同一条附件携带源图与可信蒙版，提交时展开为一对引用。 */
  preparation?: {
    maskUploadId: string
    maskChecksum: string
    sourceKind: 'asset' | 'upload'
    sourceId: string
    sourceChecksum: string
    expiresAt: string
    selection: { x: number; y: number; width: number; height: number }
  }
  prompt?: string
}

interface StoredSessionMeta {
  deletedSessionIds: string[]
  pinnedSessionIds: string[]
  sessionTitles: Record<string, string>
  messageAttachments: Record<string, ReferenceImageAttachment[]>
}

function readStoredSessionMeta(): StoredSessionMeta {
  const fallback: StoredSessionMeta = {
    deletedSessionIds: [],
    pinnedSessionIds: [],
    sessionTitles: { ...SEED_SESSION_DEFAULT_TITLES },
    messageAttachments: {},
  }
  if (typeof window === 'undefined' || typeof window.localStorage?.getItem !== 'function') {
    return fallback
  }
  try {
    const raw = window.localStorage.getItem(SESSION_META_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<StoredSessionMeta> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      deletedSessionIds: Array.isArray(parsed.deletedSessionIds)
        ? parsed.deletedSessionIds.filter((id): id is string => typeof id === 'string')
        : [],
      pinnedSessionIds: Array.isArray(parsed.pinnedSessionIds)
        ? parsed.pinnedSessionIds.filter((id): id is string => typeof id === 'string')
        : [],
      sessionTitles: {
        ...SEED_SESSION_DEFAULT_TITLES,
        ...(parsed.sessionTitles && typeof parsed.sessionTitles === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.sessionTitles).filter(
                ([k, v]) => typeof k === 'string' && typeof v === 'string' && v.trim() !== '',
              ),
            )
          : {}),
      },
      messageAttachments:
        parsed.messageAttachments && typeof parsed.messageAttachments === 'object'
          ? (parsed.messageAttachments as Record<string, ReferenceImageAttachment[]>)
          : {},
    }
  } catch {
    return fallback
  }
}

function writeStoredSessionMeta(meta: StoredSessionMeta): void {
  if (typeof window === 'undefined' || typeof window.localStorage?.setItem !== 'function') {
    return
  }
  try {
    window.localStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(meta))
  } catch {
    // 忽略隐私模式或配额限制异常
  }
}

export interface AgentConsoleUiState {
  activeSessionId: string | null
  leftSidebarOpen: boolean
  rightPanelOpen: boolean
  rightPanelTab: WorkspaceInspectorTab
  draftPrompt: string
  lastReuseQuery: string
  draftAttachments: ReferenceImageAttachment[]
  deletedSessionIds: string[]
  pinnedSessionIds: string[]
  sessionTitles: Record<string, string>
  messageAttachments: Record<string, ReferenceImageAttachment[]>

  setActiveSessionId: (sessionId: string | null) => void
  toggleLeftSidebar: () => void
  setLeftSidebarOpen: (open: boolean) => void
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: WorkspaceInspectorTab) => void
  setDraftPrompt: (prompt: string) => void
  consumeReuseQuery: (query: string) => void
  addDraftAttachment: (attachment: ReferenceImageAttachment) => boolean
  removeDraftAttachment: (id: string) => void
  clearDraftAttachments: () => void
  recordMessageAttachments: (
    sessionId: string,
    content: string,
    attachments: ReferenceImageAttachment[],
  ) => void
  deleteSession: (sessionId: string) => void
  clearSessions: (sessionIds: string[]) => void
  togglePinSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  ensureSessionTitle: (sessionId: string, title: string) => void
  resetForActor: () => void
}

const initialMeta = readStoredSessionMeta()

export const useAgentConsoleStore = create<AgentConsoleUiState>((set, get) => ({
  activeSessionId: null,
  leftSidebarOpen: true,
  rightPanelOpen: false,
  rightPanelTab: 'artifacts',
  draftPrompt: '',
  lastReuseQuery: '',
  draftAttachments: [],
  deletedSessionIds: initialMeta.deletedSessionIds,
  pinnedSessionIds: initialMeta.pinnedSessionIds,
  sessionTitles: initialMeta.sessionTitles,
  messageAttachments: initialMeta.messageAttachments,

  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  toggleLeftSidebar: () => set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen })),
  setLeftSidebarOpen: (leftSidebarOpen) => set({ leftSidebarOpen }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  setDraftPrompt: (draftPrompt) => set({ draftPrompt }),
  consumeReuseQuery: (query) => set((state) => consumeReuseQuery(state, query)),

  addDraftAttachment: (attachment) => {
    const current = get().draftAttachments
    const existingIdx = current.findIndex(
      (item) => item.id === attachment.id || item.url === attachment.url,
    )
    if (existingIdx >= 0) {
      const updated = [...current]
      updated[existingIdx] = attachment
      set({ draftAttachments: updated })
      return true
    }
    if (current.length >= MAX_DRAFT_ATTACHMENTS) {
      return false
    }
    set({ draftAttachments: [...current, attachment] })
    return true
  },

  removeDraftAttachment: (id) =>
    set((state) => ({
      draftAttachments: state.draftAttachments.filter((item) => item.id !== id),
    })),

  clearDraftAttachments: () => set({ draftAttachments: [] }),

  recordMessageAttachments: (sessionId, content, attachments) =>
    set((state) => {
      if (!sessionId || attachments.length === 0) return state
      const key = `${sessionId}:${content.trim()}`
      const messageAttachments = {
        ...state.messageAttachments,
        [key]: attachments,
      }
      writeStoredSessionMeta({
        deletedSessionIds: state.deletedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
        sessionTitles: state.sessionTitles,
        messageAttachments,
      })
      return { messageAttachments }
    }),

  deleteSession: (sessionId) =>
    set((state) => {
      const deletedSessionIds = state.deletedSessionIds.includes(sessionId)
        ? state.deletedSessionIds
        : [...state.deletedSessionIds, sessionId]
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
      const nextActive = state.activeSessionId === sessionId ? null : state.activeSessionId
      writeStoredSessionMeta({
        deletedSessionIds,
        pinnedSessionIds,
        sessionTitles: state.sessionTitles,
        messageAttachments: state.messageAttachments,
      })
      return {
        deletedSessionIds,
        pinnedSessionIds,
        activeSessionId: nextActive,
      }
    }),

  clearSessions: (sessionIds) =>
    set((state) => {
      const mergedDeleted = [...new Set([...state.deletedSessionIds, ...sessionIds])]
      const removeSet = new Set(sessionIds)
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => !removeSet.has(id))
      const nextActive =
        state.activeSessionId && removeSet.has(state.activeSessionId) ? null : state.activeSessionId
      writeStoredSessionMeta({
        deletedSessionIds: mergedDeleted,
        pinnedSessionIds,
        sessionTitles: state.sessionTitles,
        messageAttachments: state.messageAttachments,
      })
      return {
        deletedSessionIds: mergedDeleted,
        pinnedSessionIds,
        activeSessionId: nextActive,
      }
    }),

  togglePinSession: (sessionId) =>
    set((state) => {
      const pinnedSessionIds = state.pinnedSessionIds.includes(sessionId)
        ? state.pinnedSessionIds.filter((id) => id !== sessionId)
        : [sessionId, ...state.pinnedSessionIds]
      writeStoredSessionMeta({
        deletedSessionIds: state.deletedSessionIds,
        pinnedSessionIds,
        sessionTitles: state.sessionTitles,
        messageAttachments: state.messageAttachments,
      })
      return { pinnedSessionIds }
    }),

  renameSession: (sessionId, title) =>
    set((state) => {
      const trimmed = title.trim()
      if (!trimmed) return state
      const sessionTitles = { ...state.sessionTitles, [sessionId]: trimmed.slice(0, 60) }
      writeStoredSessionMeta({
        deletedSessionIds: state.deletedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
        sessionTitles,
        messageAttachments: state.messageAttachments,
      })
      return { sessionTitles }
    }),

  ensureSessionTitle: (sessionId, title) =>
    set((state) => {
      const trimmed = title.trim()
      if (!trimmed || state.sessionTitles[sessionId]) return state
      const sessionTitles = { ...state.sessionTitles, [sessionId]: trimmed.slice(0, 36) }
      writeStoredSessionMeta({
        deletedSessionIds: state.deletedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
        sessionTitles,
        messageAttachments: state.messageAttachments,
      })
      return { sessionTitles }
    }),

  resetForActor: () =>
    set({
      activeSessionId: null,
      draftPrompt: '',
      lastReuseQuery: '',
      draftAttachments: [],
    }),
}))
