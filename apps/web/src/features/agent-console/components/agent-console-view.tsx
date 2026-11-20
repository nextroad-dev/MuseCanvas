'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  CheckCircleIcon,
  ImagesIcon,
  PlusIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import type { AgentApprovalSummaryDTO } from '@musecanvas/contracts'
import {
  Button,
  Skeleton,
  SkeletonRow,
  useToast,
  iconSize,
  type BadgeTone,
} from '@/shared/components/ui'
import { useAppShellDrawer } from '@/shared/components/shells'
import { useAgentConsole } from '@/shared/hooks/useAgentConsole'
import { useAnimatedPresence } from '@/shared/hooks/useAnimatedPresence'
import { useModels } from '@/shared/hooks/useModels'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { isApiError } from '@/shared/services/api'
import {
  MOCK_AGENT_DEFINITION_ID,
  MOCK_SEED_SESSION_ID,
  mockAgentApi,
} from '@/shared/services/mock-agent-api'
import {
  parseReuseImageQuery,
  parseReuseKindQuery,
} from '../lib/agent-console-reuse'
import {
  extractToolPayloadInfo,
  formatConnectionState,
  formatTurnStatus,
  isValidUuid,
} from '../lib/agent-status'
import {
  useAgentConsoleStore,
  type ReferenceImageAttachment,
} from '../stores/agent-console-store'
import { AgentComposer } from './agent-composer'
import type { ArtifactDraftCache, ArtifactOpenRequest } from './artifact-pane'
import { ExecutionTimeline } from './execution-timeline'
import { InspectorPanel } from './inspector-panel'
import { SessionSidebar } from './session-sidebar'
import { useWorkspaceShell } from '@/features/workspace/components/workspace-shell-context'

export interface AgentConsoleViewProps {
  mode: WorkspaceMode
  /** Server-resolved default definition (runtime env); falls back to build-time env, then an existing session. */
  defaultAgentDefinition?: { agentDefinitionId: string; definitionVersion: number } | null
  /** Deep-link target from /agent/sessions/:id, applied once on mount. */
  initialSessionId?: string | null
}

const subscribeHydration = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

const STATUS_DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-status',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
}

const INSPIRATION_STARTERS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: '东方水墨意境',
    prompt: '晨雾笼罩的江南水乡古镇，一叶乌篷船缓缓划过平静水面，东方水墨写意风格，留白构图',
  },
  {
    label: '电影感人像',
    prompt: '雨夜霓虹街头的电影感特写人像，浅景深，35mm 胶片颗粒，暖冷色调对比',
  },
  {
    label: '极简静物海报',
    prompt: '暖白极简桌面静物摄影，磨砂陶瓷花瓶与干枝，柔和自然侧光，商业海报构图',
  },
  {
    label: '3D 微缩建筑',
    prompt: '精致的 3D 微缩立体悬浮庭院建筑，柔和等距视角，温暖阳光穿过云层',
  },
]

function hashSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function getHeroGreeting(hour: number, userName: string | null, seed: string): string {
  const who = userName ? `，${userName}` : ''
  let templates: string[]
  if (hour >= 5 && hour < 12) {
    templates = [
      `早上好${who}`,
      `早安${who}，今天想画点什么`,
      `晨光正好${who}`,
      `新的一天${who}，灵感就位`,
    ]
  } else if (hour >= 12 && hour < 14) {
    templates = [
      `中午好${who}`,
      `午间好${who}，来点新灵感`,
      `午后微光${who}，随时开画`,
    ]
  } else if (hour >= 14 && hour < 18) {
    templates = [
      `下午好${who}`,
      `午后好${who}，聊聊你的画面`,
      `灵感时刻${who}`,
      `下午好${who}，想把什么变成画面`,
    ]
  } else if (hour >= 18 && hour < 23) {
    templates = [
      `晚上好${who}`,
      `夜色温柔${who}，继续创作吧`,
      `忙完一天了吗${who}`,
      `晚间时光${who}，来一张新作品`,
    ]
  } else {
    templates = [
      `夜深了${who}`,
      `深夜灵感不打烊${who}`,
      `星光正好${who}，写下你的构想`,
    ]
  }
  return templates[hashSeed(seed) % templates.length]!
}

function ConsoleHydrationSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载工作区"
      className="flex min-h-0 min-w-0 flex-1 bg-canvas"
    >
      <h1 className="sr-only">Agent 操作台</h1>
      <aside className="hidden w-64 shrink-0 flex-col gap-3 border-r border-border/70 bg-surface/60 p-4 md:flex lg:w-72">
        <Skeleton className="h-8 w-28" />
        <SkeletonRow cells={1} />
        <SkeletonRow cells={1} />
        <SkeletonRow cells={1} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-between px-4 pb-4 pt-16 sm:px-6 sm:pb-6 sm:pt-14 lg:px-10">
          <div className="mx-auto w-full max-w-3xl space-y-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl">
            <Skeleton className="ml-auto h-14 w-2/3 rounded-panel" />
            <Skeleton className="h-28 w-5/6 rounded-card" />
            <Skeleton className="h-20 w-3/4 rounded-card" />
          </div>
          <div className="mx-auto mt-6 w-full max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl">
            <Skeleton className="h-24 w-full rounded-panel" />
          </div>
        </div>
      </div>
      <span className="sr-only">正在加载工作区</span>
    </div>
  )
}

/**
 * `/generate` 3 栏可折叠 Agent Operation Console 视图。
 * 左侧会话栏自 `md`（>=960px）内联停靠，右侧检查器自 `lg`（>=1280px）内联停靠；
 * 全量服务端状态交由 `useAgentConsole` 与 TanStack Query，易失 UI 状态交由 `useAgentConsoleStore`。
 */
export function AgentConsoleView({ mode, defaultAgentDefinition = null, initialSessionId = null }: AgentConsoleViewProps) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot)
  const reuseQuery = useSearchParams().toString()
  const reuseKind = parseReuseKindQuery(reuseQuery)
  const { toast } = useToast()
  const shellState = useWorkspaceShell()
  const appDrawer = useAppShellDrawer()
  // AppShell 的 sidebarSlot 挂载点：会话列表通过 portal 注入全局侧栏，
  // 与 /library 共用同一套侧栏外壳，避免两套导航。
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null)
  const setSidebarSlot = shellState?.setSidebarSlot
  useEffect(() => {
    if (!setSidebarSlot) return
    setSidebarSlot(<div ref={setSidebarHost} />)
    return () => {
      setSidebarSlot(null)
      setSidebarHost(null)
    }
  }, [setSidebarSlot])

  const activeSessionId = useAgentConsoleStore((state) => state.activeSessionId)
  const rightPanelOpen = useAgentConsoleStore((state) => state.rightPanelOpen)
  const draftPrompt = useAgentConsoleStore((state) => state.draftPrompt)
  const draftAttachments = useAgentConsoleStore((state) => state.draftAttachments)
  const deletedSessionIds = useAgentConsoleStore((state) => state.deletedSessionIds)
  const pinnedSessionIds = useAgentConsoleStore((state) => state.pinnedSessionIds)
  const sessionTitles = useAgentConsoleStore((state) => state.sessionTitles)
  const messageAttachments = useAgentConsoleStore((state) => state.messageAttachments)

  const setActiveSessionId = useAgentConsoleStore((state) => state.setActiveSessionId)
  const toggleRightPanel = useAgentConsoleStore((state) => state.toggleRightPanel)
  const setRightPanelOpen = useAgentConsoleStore((state) => state.setRightPanelOpen)
  const setDraftPrompt = useAgentConsoleStore((state) => state.setDraftPrompt)
  const consumeReuseQuery = useAgentConsoleStore((state) => state.consumeReuseQuery)
  const addDraftAttachment = useAgentConsoleStore((state) => state.addDraftAttachment)
  const removeDraftAttachment = useAgentConsoleStore((state) => state.removeDraftAttachment)
  const clearDraftAttachments = useAgentConsoleStore((state) => state.clearDraftAttachments)
  const recordMessageAttachments = useAgentConsoleStore((state) => state.recordMessageAttachments)
  const deleteSession = useAgentConsoleStore((state) => state.deleteSession)
  const clearSessions = useAgentConsoleStore((state) => state.clearSessions)
  const togglePinSession = useAgentConsoleStore((state) => state.togglePinSession)
  const renameSession = useAgentConsoleStore((state) => state.renameSession)
  const ensureSessionTitle = useAgentConsoleStore((state) => state.ensureSessionTitle)
  const resetForActor = useAgentConsoleStore((state) => state.resetForActor)

  const agentConsole = useAgentConsole(hydrated ? activeSessionId : null, { mode })
  // A /agent/sessions/:id deep link wins once; later in-console selection is
  // normal navigation and must not be overridden by the stale prop.
  const appliedInitialSession = useRef<string | null>(null)
  useEffect(() => {
    if (!initialSessionId) return
    const id = initialSessionId.toLowerCase()
    if (!isValidUuid(id) || appliedInitialSession.current === id) return
    appliedInitialSession.current = id
    setActiveSessionId(id)
  }, [initialSessionId, setActiveSessionId])
  const modelsQuery = useModels()
  // 局部修改需要一个真正声明了 inpaint（mask 输入）的图片模型：这是服务端
  // prepareImageEdit 与 Worker 审批门禁共同要求的前提，不在前端猜。
  const editModelId = useMemo(() => (modelsQuery.data ?? [])
    .find((model) => model.modelKind === 'image' && model.modes.includes('inpaint')
      && model.inputSlots.some((slot) => slot.role === 'mask'))?.id ?? null, [modelsQuery.data])
  const visibleSessions = agentConsole.sessions.filter(
    (session) => !(deletedSessionIds ?? []).includes(session.id),
  )

  const artifactDrafts = useRef<ArtifactDraftCache>(new Map())
  const [artifactTarget, setArtifactTarget] = useState<{ scope: string; request: ArtifactOpenRequest } | null>(null)
  const artifactScope = `${mode}:${agentConsole.actorId}:${agentConsole.sessionId ?? ''}`
  useEffect(() => { artifactDrafts.current.clear() }, [mode, agentConsole.actorId])
  function openArtifact(request: Omit<ArtifactOpenRequest, 'nonce'>) {
    setArtifactTarget({ scope: artifactScope, request: { ...request, nonce: Date.now() } })
    setRightPanelOpen(true)
  }
  function jumpToMessage(sourceItemId: string) {
    const message = typeof document === 'undefined' ? null : document.getElementById(`agent-item-${sourceItemId}`)
    if (message) {
      setRightPanelOpen(false)
      message.scrollIntoView({ block: 'center' })
      message.focus({ preventScroll: true })
    } else {
      toast.info('来源消息尚未加载', '请在时间线中加载更多记录后再定位。')
    }
  }

  const [creatingSession, setCreatingSession] = useState(false)
  const creatingSessionRef = useRef(false)
  const [resolvingApproval, setResolvingApproval] = useState<{
    id: string
    decision: 'approved' | 'rejected'
  } | null>(null)
  const resolvingApprovalRef = useRef(false)
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({})

  // 卸载时清理 reuseQuery 消费身份但保留草稿，确保再次从图库复用同一素材时仍能导入。
  useEffect(
    () => () => {
      if (typeof useAgentConsoleStore.getState === 'function') {
        useAgentConsoleStore.getState().consumeReuseQuery('')
      } else {
        consumeReuseQuery('')
      }
    },
    [consumeReuseQuery],
  )

  useEffect(() => {
    consumeReuseQuery(reuseQuery)
    const imageReuse = parseReuseImageQuery(reuseQuery)
    if (imageReuse) {
      addDraftAttachment?.({
        id: imageReuse.assetId ? `lib-${imageReuse.assetId}` : `reuse-${imageReuse.url}`,
        url: imageReuse.url,
        name: imageReuse.label || '图库参考图',
        source: 'library',
        assetId: imageReuse.assetId ?? undefined,
        prompt: imageReuse.prompt ?? undefined,
      })
    }
  }, [reuseQuery, consumeReuseQuery, addDraftAttachment])

  // 检查器（右侧栏）打开时支持 Esc 关闭；会话列表由全局侧栏承载。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined' || !rightPanelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setRightPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hydrated, rightPanelOpen, setRightPanelOpen])

  // 全局快捷键 Ctrl/Cmd + K：打开移动抽屉（窄视口）并聚焦会话搜索框。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 960px)').matches) {
        appDrawer.openMobileDrawer()
      }
      const focusSearchOrList = () => {
        if (typeof document === 'undefined') return
        const searchInput = document.querySelector<HTMLElement>('[data-session-search="true"]')
        if (searchInput) {
          searchInput.focus()
          return
        }
        document
          .querySelector<HTMLElement>('[aria-label="工作区侧栏"] [role="list"], [aria-label="工作区侧栏"] ul')
          ?.focus()
      }
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(focusSearchOrList)
      } else {
        setTimeout(focusSearchOrList, 0)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hydrated, appDrawer])

  // Mock 模式首次加载自动选中内置演示会话，展示完整交互时间线。
  useEffect(() => {
    if (mode !== 'mock' || !hydrated) return
    if (activeSessionId !== null) return
    if (visibleSessions.length === 0) return
    const seeded =
      visibleSessions.find((session) => session.id === MOCK_SEED_SESSION_ID) ??
      visibleSessions[0]
    if (seeded) setActiveSessionId(seeded.id)
  }, [mode, hydrated, activeSessionId, visibleSessions, setActiveSessionId])

  // 自动根据首条用户消息生成对话标题（若用户尚未手动命名）。
  useEffect(() => {
    if (!activeSessionId || agentConsole.items.length === 0) return
    const firstUserMsg = agentConsole.items.find((item) => item.type === 'user_message')
    const rawContent =
      firstUserMsg && typeof firstUserMsg.payload?.content === 'string'
        ? firstUserMsg.payload.content.trim()
        : ''
    if (rawContent) {
      ensureSessionTitle?.(activeSessionId, rawContent.slice(0, 32))
    }
  }, [activeSessionId, agentConsole.items, ensureSessionTitle])

  // 登录用户切换时重置客户端易失状态，防止跨账号残留选中会话或草稿。
  const previousActorRef = useRef('')
  useEffect(() => {
    if (!hydrated) return
    const nextActor = agentConsole.actorId
    const prevActor = previousActorRef.current
    if (prevActor && nextActor && prevActor !== nextActor) {
      resetForActor()
    }
    if (nextActor) {
      previousActorRef.current = nextActor
    }
  }, [hydrated, agentConsole.actorId, resetForActor])

  useEffect(() => {
    setApprovalErrors({})
  }, [activeSessionId])

  async function handleResolveApproval(
    approval: AgentApprovalSummaryDTO,
    decision: 'approved' | 'rejected',
  ) {
    if (resolvingApprovalRef.current) return
    resolvingApprovalRef.current = true
    setResolvingApproval({ id: approval.id, decision })
    setApprovalErrors((prev) => {
      if (!prev[approval.id]) return prev
      const next = { ...prev }
      delete next[approval.id]
      return next
    })
    try {
      const updated = await agentConsole.resolveApproval({
        approvalId: approval.id,
        decision,
        expectedArgumentsHash: approval.argumentsHash,
      })
      if (updated.status === 'expired') {
        toast.warning('审批已过期', '该工具调用审批已超过有效期，请重新发起指令。')
      } else if (decision === 'approved') {
        toast.success('已批准执行', 'Agent 将继续执行该工具调用。')
      } else {
        toast.info('已拒绝调用', 'Agent 已收到拒绝决定并终止本次工具调用。')
      }
    } catch (error) {
      const expired = isApiError(error) && error.code === 'APPROVAL_EXPIRED'
      const conflict = isApiError(error) && error.status === 409
      const message = expired
        ? error.message || '审批已过期，请重新发起指令。'
        : conflict
          ? '审批状态或参数发生冲突，请核对最新状态后重试。'
          : isApiError(error)
            ? error.message || '提交审批决定失败，请稍后重试。'
            : '提交审批决定失败，请检查网络连接或服务状态后重试。'
      setApprovalErrors((prev) => ({ ...prev, [approval.id]: message }))
      if (expired) {
        toast.warning('审批已过期', message)
      } else {
        toast.error('审批提交失败', message)
      }
    } finally {
      resolvingApprovalRef.current = false
      setResolvingApproval(null)
    }
  }

  function resolveDefaultDefinition(): { agentDefinitionId: string; definitionVersion: number } | null {
    if (mode === 'mock') {
      return { agentDefinitionId: MOCK_AGENT_DEFINITION_ID, definitionVersion: 1 }
    }
    // Provisioned per deployment and resolved by the server at request time.
    if (defaultAgentDefinition) return defaultAgentDefinition
    const envDefinitionId =
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_AGENT_DEFINITION_ID?.trim() : ''
    if (envDefinitionId && isValidUuid(envDefinitionId)) {
      const envVersion = Number(
        typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_AGENT_DEFINITION_VERSION : '1',
      )
      return {
        agentDefinitionId: envDefinitionId.toLowerCase(),
        definitionVersion: Number.isSafeInteger(envVersion) && envVersion >= 1 ? envVersion : 1,
      }
    }
    const baseSession = agentConsole.session ?? agentConsole.sessions[0]
    if (baseSession) {
      return {
        agentDefinitionId: baseSession.agentDefinitionId,
        definitionVersion: baseSession.definitionVersion,
      }
    }
    return null
  }

  async function handleCreateSession() {
    if (
      creatingSessionRef.current ||
      agentConsole.mutations.createSession.isPending ||
      agentConsole.serviceStatus === 'disabled_404'
    ) {
      return
    }
    const resolved = resolveDefaultDefinition()
    if (!resolved) {
      toast.warning(
        '暂无法一键新建对话',
        '当前服务端尚未配置默认 Agent，请联系管理员设置或稍后再试。',
      )
      return
    }
    creatingSessionRef.current = true
    setCreatingSession(true)
    try {
      const created = await agentConsole.createSession(resolved)
      setActiveSessionId(created.id)
      appDrawer.closeMobileDrawer()
      toast.success(
        '新对话已创建',
        '可以开始下达创作指令。',
      )
    } catch (error) {
      toast.error(
        '新建对话失败',
        error instanceof Error && error.message ? error.message : '请检查服务状态后重试。',
      )
    } finally {
      creatingSessionRef.current = false
      setCreatingSession(false)
    }
  }

  const rightPresence = useAnimatedPresence(rightPanelOpen)

  if (!hydrated) {
    return <ConsoleHydrationSkeleton />
  }

  const isConnectionDegraded =
    agentConsole.connectionState === 'reconnecting' ||
    agentConsole.connectionState === 'resyncing' ||
    agentConsole.connectionState === 'error'
  const activeTurnMeta =
    agentConsole.turnActive && agentConsole.activeTurn
      ? formatTurnStatus(agentConsole.activeTurn.status, {
          cancelRequestedAt: agentConsole.activeTurn.cancelRequestedAt,
          errorCode: agentConsole.activeTurn.error?.code,
        })
      : null
  const inlineStatus = isConnectionDegraded
    ? formatConnectionState(agentConsole.connectionState)
    : activeTurnMeta
  const pendingApprovalCount = agentConsole.pendingApprovals.length

  async function handleDeleteSession(sessionId: string) {
    try {
      if (mode === 'mock') {
        await mockAgentApi?.deleteSession?.(sessionId)
      }
      const remaining = visibleSessions.filter((session) => session.id !== sessionId)
      const nextActiveId =
        activeSessionId === sessionId ? (remaining[0]?.id ?? null) : activeSessionId
      deleteSession?.(sessionId)
      setActiveSessionId(nextActiveId)
      if (mode === 'mock') {
        void agentConsole.sessionsQuery.refetch?.()
      }
      toast.info('已在此设备隐藏对话', '仅从当前设备的会话列表中隐藏，未删除服务端对话记录。')
    } catch (error) {
      toast.error(
        '隐藏对话失败',
        error instanceof Error && error.message ? error.message : '请稍后重试。',
      )
    }
  }

  async function handleClearSessions() {
    if (visibleSessions.length === 0) return
    try {
      if (mode === 'mock') {
        await mockAgentApi?.clearSessions?.()
      }
      clearSessions?.(visibleSessions.map((session) => session.id))
      setActiveSessionId(null)
      if (mode === 'mock') {
        void agentConsole.sessionsQuery.refetch?.()
      }
      toast.info('已清空此设备上的对话', '仅清除当前设备上的会话显示，未删除服务端对话记录。')
    } catch (error) {
      toast.error(
        '清空本机对话失败',
        error instanceof Error && error.message ? error.message : '请稍后重试。',
      )
    }
  }

  function handleReuseImage(attachment: ReferenceImageAttachment) {
    const added = addDraftAttachment ? addDraftAttachment(attachment) : true
    if (added) {
      toast.success('已添加参考图到输入框', '可在下方输入区继续编辑指令或叠加参考图')
    } else {
      toast.warning('参考图数量已达上限', '单次最多附加 4 张参考图，请先移除部分图片')
    }
  }

  function handleApplyStarter(prompt: string) {
    setDraftPrompt(prompt)
    if (typeof document !== 'undefined') {
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 Agent 指令"]')
        ?.focus()
    }
  }

  const isEmptyComposerCentered =
    Boolean(agentConsole.sessionId) &&
    !agentConsole.snapshotQuery.isPending &&
    agentConsole.serviceStatus !== 'disabled_404' &&
    agentConsole.serviceStatus !== 'admission_closed_503' &&
    !(agentConsole.serviceStatus === 'error' && agentConsole.error) &&
    !agentConsole.timeline.resyncRequired &&
    !agentConsole.hasOlderItems &&
    agentConsole.items.length === 0 &&
    !agentConsole.turnActive &&
    pendingApprovalCount === 0

  const userName =
    shellState?.user?.email?.split('@')[0] ?? (mode === 'mock' ? '创作者' : null)
  const heroGreeting = getHeroGreeting(
    new Date().getHours(),
    userName,
    agentConsole.sessionId ?? 'default',
  )

  return (
    <div
      data-workspace-mode={mode}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      <h1 className="sr-only">Agent 操作台</h1>
      {/* 会话列表注入 AppShell 全局侧栏：/generate 与 /library 共用同一套侧栏。 */}
      {sidebarHost
        ? createPortal(
            <SessionSidebar
              embedded
              console={agentConsole}
              sessions={visibleSessions}
              activeSessionId={activeSessionId}
              pinnedSessionIds={pinnedSessionIds}
              sessionTitles={sessionTitles}
              onSelectSession={(id) => setActiveSessionId(id)}
              onCreateSession={() => void handleCreateSession()}
              onDeleteSession={handleDeleteSession}
              onClearSessions={handleClearSessions}
              onTogglePinSession={togglePinSession}
              onRenameSession={renameSession}
              onReuseImage={handleReuseImage}
              creatingSession={creatingSession || agentConsole.mutations.createSession.isPending}
              onCloseMobile={appDrawer.closeMobileDrawer}
            />,
            sidebarHost,
          )
        : null}

      {/* 主画布：无顶栏沉浸画布 + 悬浮角标控件 + 执行时间线 + 待审批控制栏 + 悬浮交互输入器 */}
      <section
        aria-label="Agent 执行控制台"
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas',
          isEmptyComposerCentered && 'justify-center overflow-y-auto pt-16 pb-4',
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky flex flex-wrap items-start justify-between gap-2 bg-gradient-to-b from-canvas via-canvas/80 to-transparent pb-6 pt-3 px-3 sm:px-5 sm:pt-3.5">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-pill border border-border/60 bg-surface/85 p-1 shadow-soft backdrop-blur-md">
            <Button
              size="icon"
              variant="ghost"
              className="rounded-pill sm:size-8 md:hidden"
              aria-label="打开会话列表"
              aria-expanded={appDrawer.mobileDrawerOpen}
              onClick={appDrawer.openMobileDrawer}
              icon={<SidebarSimpleIcon className={iconSize.sm} aria-hidden="true" />}
            />
            <Button
              size="icon"
              variant="ghost"
              className="rounded-pill sm:size-8"
              aria-label="新建对话"
              loading={creatingSession || agentConsole.mutations.createSession.isPending}
              disabled={
                agentConsole.serviceStatus === 'disabled_404' ||
                creatingSession ||
                agentConsole.mutations.createSession.isPending
              }
              onClick={() => void handleCreateSession()}
              icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
            />
            <Button
              asChild
              size="icon"
              variant="ghost"
              className="rounded-pill sm:size-8"
              aria-label="作品图库"
            >
              <Link href={APP_ROUTES.library} prefetch>
                <ImagesIcon className={iconSize.sm} aria-hidden="true" />
              </Link>
            </Button>
          </div>

          <div className="pointer-events-auto ml-auto flex items-center gap-2">
            {inlineStatus ? (
              <div className="flex items-center gap-1.5 rounded-pill border border-border/60 bg-surface/85 px-3 py-1.5 text-caption text-muted-foreground shadow-soft backdrop-blur-md">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-pill', STATUS_DOT_TONES[inlineStatus.tone])}
                />
                <span className="max-w-24 truncate sm:max-w-32">{inlineStatus.label}</span>
              </div>
            ) : null}

            {!rightPanelOpen ? (
              <div className="relative flex items-center rounded-pill border border-border/60 bg-surface/85 p-1 shadow-soft backdrop-blur-md">
                <Button
                  size="icon"
                  variant="ghost"
                  className="rounded-pill sm:size-8"
                  aria-label="展开检查器"
                  aria-expanded={false}
                  onClick={() => toggleRightPanel()}
                  icon={<SlidersHorizontalIcon className={iconSize.sm} aria-hidden="true" />}
                />
                {pendingApprovalCount > 0 ? (
                  <span
                    aria-label={`有 ${pendingApprovalCount} 条待审批工具`}
                    className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-pill bg-warning px-1 text-caption font-medium leading-4 text-on-warning shadow-soft"
                  >
                    {pendingApprovalCount}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <ExecutionTimeline
          console={agentConsole}
          onOpenArtifact={openArtifact}
          onCreateSession={() => void handleCreateSession()}
          creatingSession={creatingSession || agentConsole.mutations.createSession.isPending}
          onReusePrompt={(prompt) => {
            setDraftPrompt(prompt)
            toast.info('已填入提示词草稿', '可在下方输入区编辑后发送')
          }}
          onReuseImage={handleReuseImage}
          messageAttachments={messageAttachments}
          onResolveApproval={handleResolveApproval}
          resolvingApproval={resolvingApproval}
          approvalErrors={approvalErrors}
        />

        {pendingApprovalCount > 0 && agentConsole.serviceStatus !== 'disabled_404' ? (
          <div
            role="region"
            aria-label="待审批工具控制栏"
            className="shrink-0 px-4 pt-2 sm:px-6 lg:px-10"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-panel border border-warning-border bg-warning-soft/55 p-3 shadow-soft backdrop-blur-sm lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl">
              {agentConsole.pendingApprovals.map((approval) => {
                const matchedTool = agentConsole.timeline.tools[approval.toolCallId]
                const matchedApprovalItem = agentConsole.items.find(
                  (item) =>
                    item.type === 'approval' &&
                    (extractToolPayloadInfo(item).approvalId === approval.id ||
                      item.toolCallId === approval.toolCallId),
                )
                const payloadInfo = matchedApprovalItem
                  ? extractToolPayloadInfo(matchedApprovalItem)
                  : null
                const toolName = matchedTool?.toolName ?? payloadInfo?.toolName ?? 'generate_image'
                const promptPreview =
                  payloadInfo?.prompt || payloadInfo?.message || '等待确认执行当前工具调用'
                const resolvingDecision =
                  resolvingApproval?.id === approval.id ? resolvingApproval.decision : null
                const busy = resolvingDecision !== null

                return (
                  <div
                    key={approval.id}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-warning-soft text-warning">
                        <ShieldWarningIcon className={iconSize.sm} aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui font-medium text-foreground">
                          待审批工具 · {toolName}
                        </p>
                        <p className="truncate text-caption text-muted-foreground">
                          {promptPreview}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        className="rounded-pill"
                        disabled={busy}
                        loading={resolvingDecision === 'rejected'}
                        onClick={() => void handleResolveApproval(approval, 'rejected')}
                        icon={<XCircleIcon className={iconSize.sm} aria-hidden="true" />}
                      >
                        拒绝
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        className="rounded-pill"
                        disabled={busy}
                        loading={resolvingDecision === 'approved'}
                        onClick={() => void handleResolveApproval(approval, 'approved')}
                        icon={<CheckCircleIcon className={iconSize.sm} aria-hidden="true" />}
                      >
                        批准执行
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {isEmptyComposerCentered ? (
          <div className="motion-fade-in mx-auto w-full max-w-3xl px-4 pb-5 text-center sm:px-6 lg:max-w-4xl lg:px-10 xl:max-w-5xl 2xl:max-w-6xl">
            <h2 className="font-art text-cta font-normal tracking-tight break-words text-foreground">
              {heroGreeting}
            </h2>
          </div>
        ) : null}

        <AgentComposer
          console={agentConsole}
          draftPrompt={draftPrompt}
          onChangeDraft={setDraftPrompt}
          draftAttachments={draftAttachments ?? []}
          onAddAttachment={addDraftAttachment}
          onRemoveAttachment={removeDraftAttachment}
          onClearAttachments={clearDraftAttachments}
          onRecordMessageAttachments={recordMessageAttachments}
          reuseKind={reuseKind}
          editModelId={editModelId}
          onCreateSession={() => void handleCreateSession()}
          creatingSession={creatingSession || agentConsole.mutations.createSession.isPending}
        />

        {isEmptyComposerCentered ? (
          <div className="motion-fade-in mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 px-4 pt-1 sm:px-6 lg:max-w-4xl lg:px-10 xl:max-w-5xl 2xl:max-w-6xl">
            {INSPIRATION_STARTERS.map((starter, index) => (
              <button
                key={starter.label}
                type="button"
                style={{ '--stagger-index': index } as CSSProperties}
                onClick={() => handleApplyStarter(starter.prompt)}
                className="motion-press motion-reveal motion-stagger inline-flex items-center gap-1.5 rounded-pill border border-border/70 bg-surface/80 px-3.5 py-1.5 text-caption text-muted-foreground hover:border-border hover:bg-surface hover:text-foreground"
              >
                <SparkleIcon className={cn(iconSize.xs, 'text-accent/80')} aria-hidden="true" />
                {starter.label}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {/* 检查器悬浮卡片点击外部关闭遮罩 */}
      {rightPresence.mounted ? (
        <div
          aria-hidden="true"
          data-inspector-backdrop="true"
          onClick={() => setRightPanelOpen(false)}
          className={cn(
            'absolute inset-0 z-overlay bg-overlay/15 lg:bg-transparent',
            rightPresence.closing ? 'pointer-events-none motion-fade-out' : 'motion-fade-in',
          )}
        />
      ) : null}

      {/* 右上角检查器悬浮卡片（贴右） */}
      {rightPresence.mounted ? (
        <div
          role="region"
          aria-label="Agent 检查器面板"
          onAnimationEnd={rightPresence.onAnimationEnd}
          className={cn(
            'absolute right-0 top-3 z-overlay flex max-h-[min(80dvh,680px)] w-[min(42rem,calc(100vw-0.75rem))] max-w-[calc(100vw-0.75rem)] flex-col overflow-hidden rounded-l-panel rounded-r-none border border-r-0 border-border/75 bg-surface/95 shadow-floating backdrop-blur-md sm:top-3.5',
            rightPresence.closing ? 'pointer-events-none motion-panel-out' : 'motion-panel-in',
          )}
        >
          <InspectorPanel
            console={agentConsole}
            artifactRequest={artifactTarget?.scope === artifactScope ? artifactTarget.request : undefined}
            artifactDrafts={artifactDrafts.current}
            onJumpToMessage={jumpToMessage}
            onReusePrompt={(prompt) => {
              setDraftPrompt(prompt)
              toast.info('已填入提示词草稿', '可在下方输入区编辑后发送')
            }}
            onResolveApproval={handleResolveApproval}
            resolvingApproval={resolvingApproval}
            approvalErrors={approvalErrors}
            onClose={() => setRightPanelOpen(false)}
          />
        </div>
      ) : null}
    </div>
  )
}
