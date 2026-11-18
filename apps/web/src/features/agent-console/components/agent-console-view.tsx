'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  CheckCircleIcon,
  ImagesIcon,
  PlusIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
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
import { useAgentConsole } from '@/shared/hooks/useAgentConsole'
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
import { ExecutionTimeline } from './execution-timeline'
import { SessionSidebar } from './session-sidebar'
import { useWorkspaceShell } from '@/features/workspace/components/workspace-shell-context'

export interface AgentConsoleViewProps {
  mode: WorkspaceMode
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

function isDesktopLeftInline(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia?.('(min-width: 960px)')?.matches ?? true
}

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
export function AgentConsoleView({ mode }: AgentConsoleViewProps) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot)
  const reuseQuery = useSearchParams().toString()
  const reuseKind = parseReuseKindQuery(reuseQuery)
  const { toast } = useToast()
  const shellState = useWorkspaceShell()

  const activeSessionId = useAgentConsoleStore((state) => state.activeSessionId)
  const leftSidebarOpen = useAgentConsoleStore((state) => state.leftSidebarOpen)
  const draftPrompt = useAgentConsoleStore((state) => state.draftPrompt)
  const draftAttachments = useAgentConsoleStore((state) => state.draftAttachments)
  const deletedSessionIds = useAgentConsoleStore((state) => state.deletedSessionIds)
  const pinnedSessionIds = useAgentConsoleStore((state) => state.pinnedSessionIds)
  const sessionTitles = useAgentConsoleStore((state) => state.sessionTitles)
  const messageAttachments = useAgentConsoleStore((state) => state.messageAttachments)

  const setActiveSessionId = useAgentConsoleStore((state) => state.setActiveSessionId)
  const toggleLeftSidebar = useAgentConsoleStore((state) => state.toggleLeftSidebar)
  const setLeftSidebarOpen = useAgentConsoleStore((state) => state.setLeftSidebarOpen)
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
  const visibleSessions = agentConsole.sessions.filter(
    (session) => !(deletedSessionIds ?? []).includes(session.id),
  )

  const [creatingSession, setCreatingSession] = useState(false)
  const creatingSessionRef = useRef(false)
  const [resolvingApproval, setResolvingApproval] = useState<{
    id: string
    decision: 'approved' | 'rejected'
  } | null>(null)
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

  // 窄视口首屏折叠会以抽屉形态挂载的左侧栏（<960px 收起左栏）。
  const viewportInitializedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || viewportInitializedRef.current || typeof window === 'undefined') return
    viewportInitializedRef.current = true
    if (!isDesktopLeftInline()) {
      setLeftSidebarOpen(false)
    }
  }, [hydrated, setLeftSidebarOpen])

  // 抽屉形态侧栏打开时支持 Esc 关闭，且保留桌面内联侧栏。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return
    if (!leftSidebarOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (leftSidebarOpen && !isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hydrated, leftSidebarOpen, setLeftSidebarOpen])

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
    if (resolvingApproval) return
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
      const expired =
        isApiError(error) && (error.code === 'APPROVAL_EXPIRED' || error.status === 409)
      const message = expired
        ? error instanceof Error && error.message
          ? error.message
          : '审批状态已变化或已过期，已刷新最新状态。'
        : error instanceof Error && error.message
          ? error.message
          : '提交审批决定失败，请稍后重试。'
      setApprovalErrors((prev) => ({ ...prev, [approval.id]: message }))
      if (expired) {
        toast.warning('审批状态已更新', message)
      } else {
        toast.error('审批提交失败', message)
      }
    } finally {
      setResolvingApproval(null)
    }
  }

  function resolveDefaultDefinition(): { agentDefinitionId: string; definitionVersion: number } | null {
    if (mode === 'mock') {
      return { agentDefinitionId: MOCK_AGENT_DEFINITION_ID, definitionVersion: 1 }
    }
    const baseSession = agentConsole.session ?? agentConsole.sessions[0]
    if (baseSession) {
      return {
        agentDefinitionId: baseSession.agentDefinitionId,
        definitionVersion: baseSession.definitionVersion,
      }
    }
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
      if (!isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
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

  function handleToggleLeftSidebar() {
    toggleLeftSidebar()
  }

  function handleDeleteSession(sessionId: string) {
    const remaining = visibleSessions.filter((session) => session.id !== sessionId)
    const nextActiveId =
      activeSessionId === sessionId ? (remaining[0]?.id ?? null) : activeSessionId
    deleteSession?.(sessionId)
    setActiveSessionId(nextActiveId)
    if (mode === 'mock') {
      void mockAgentApi?.deleteSession?.(sessionId)
      void agentConsole.sessionsQuery.refetch?.()
    }
    toast.info('已删除对话')
  }

  function handleClearSessions() {
    if (visibleSessions.length === 0) return
    clearSessions?.(visibleSessions.map((session) => session.id))
    setActiveSessionId(null)
    if (mode === 'mock') {
      void mockAgentApi?.clearSessions?.()
      void agentConsole.sessionsQuery.refetch?.()
    }
    toast.info('已清空全部对话')
  }

  function handleReuseImage(attachment: ReferenceImageAttachment) {
    const added = addDraftAttachment ? addDraftAttachment(attachment) : true
    if (added) {
      toast.success('已添加参考图到输入框', '可在下方输入区继续编辑指令或叠加参考图')
    } else {
      toast.warning('参考图数量已达上限', '单次最多附加 4 张参考图，请先移除部分图片')
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
      {/* 移动端抽屉遮罩（<960px 左栏展开时显示） */}
      {leftSidebarOpen ? (
        <div
          aria-hidden="true"
          onClick={() => {
            if (!isDesktopLeftInline()) setLeftSidebarOpen(false)
          }}
          className="motion-fade-in absolute inset-0 z-sticky bg-overlay/35 backdrop-blur-xs md:hidden"
        />
      ) : null}

      {/* 左栏：会话列表与本对话产物胶片（>=960px 内联停靠，<960px 抽屉） */}
      <aside
        aria-label="Agent 会话侧栏"
        className={cn(
          'max-md:motion-drawer-in-left absolute inset-y-0 left-0 z-sticky w-72 max-w-[85vw] border-r border-border/70 bg-surface/95 backdrop-blur-md shadow-drawer',
          'md:static md:inset-y-auto md:z-auto md:h-full md:w-64 md:max-w-none md:shrink-0 md:bg-surface/60 md:backdrop-blur-none md:shadow-none lg:w-72',
          !leftSidebarOpen && 'hidden',
        )}
      >
        <SessionSidebar
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
          onToggleSidebar={handleToggleLeftSidebar}
          onCloseMobile={() => {
            if (!isDesktopLeftInline()) {
              setLeftSidebarOpen(false)
            }
          }}
        />
      </aside>

      {/* 主画布：无顶栏沉浸画布 + 悬浮角标控件 + 执行时间线 + 待审批控制栏 + 悬浮交互输入器 */}
      <section
        aria-label="Agent 执行控制台"
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas',
          isEmptyComposerCentered && 'justify-center',
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky flex items-start justify-between gap-2 p-3 sm:px-5 sm:pt-3.5">
          <div
            className={cn(
              'pointer-events-auto flex items-center gap-0.5 rounded-pill border border-border/60 bg-surface/85 p-1 shadow-soft backdrop-blur-md',
              leftSidebarOpen && 'md:hidden',
            )}
          >
            <Button
              size="icon"
              variant="ghost"
              className="rounded-pill sm:size-8"
              aria-label={leftSidebarOpen ? '收起会话列表' : '展开会话列表'}
              aria-expanded={leftSidebarOpen}
              onClick={handleToggleLeftSidebar}
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

          {inlineStatus ? (
            <div className="pointer-events-auto ml-auto flex items-center gap-1.5 rounded-pill border border-border/60 bg-surface/85 px-3 py-1.5 text-caption text-muted-foreground shadow-soft backdrop-blur-md">
              <span
                aria-hidden="true"
                className={cn('size-1.5 shrink-0 rounded-pill', STATUS_DOT_TONES[inlineStatus.tone])}
              />
              <span className="max-w-32 truncate">{inlineStatus.label}</span>
            </div>
          ) : null}
        </div>

        <ExecutionTimeline
          console={agentConsole}
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
          <div className="motion-fade-in mx-auto w-full max-w-3xl px-4 pb-6 text-center sm:px-6 lg:max-w-4xl lg:px-10 xl:max-w-5xl 2xl:max-w-6xl">
            <h1 className="font-art text-cta font-normal tracking-tight break-words text-foreground">
              {heroGreeting}
            </h1>
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
          onCreateSession={() => void handleCreateSession()}
          creatingSession={creatingSession || agentConsole.mutations.createSession.isPending}
        />
      </section>
    </div>
  )
}
