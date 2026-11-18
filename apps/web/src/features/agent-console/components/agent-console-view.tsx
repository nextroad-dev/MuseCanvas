'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowClockwiseIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
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
import { agentSessionRoute } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { isApiError } from '@/shared/services/api'
import { MOCK_SEED_SESSION_ID } from '@/shared/services/mock-agent-api'
import {
  parseInspectorPanelQuery,
  parseReuseKindQuery,
} from '../lib/agent-console-reuse'
import {
  formatConnectionState,
  formatTurnStatus,
} from '../lib/agent-status'
import { useAgentConsoleStore } from '../stores/agent-console-store'
import { AgentComposer } from './agent-composer'
import { ExecutionTimeline } from './execution-timeline'
import { InspectorPanel } from './inspector-panel'
import { SessionSidebar } from './session-sidebar'

export interface AgentConsoleViewProps {
  mode: WorkspaceMode
  initialSessionId?: string
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

function isWideInspectorInline(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia?.('(min-width: 1280px)')?.matches ?? true
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
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 bg-canvas/85 px-3 sm:px-5">
          <Skeleton className="h-5 w-24 rounded-control" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-16 rounded-pill" />
            <Skeleton className="h-7 w-20 rounded-pill" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-between px-4 pb-4 pt-6 sm:px-6 sm:pb-6">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <Skeleton className="ml-auto h-14 w-2/3 rounded-panel" />
            <Skeleton className="h-28 w-5/6 rounded-card" />
            <Skeleton className="h-20 w-3/4 rounded-card" />
          </div>
          <div className="mx-auto mt-6 w-full max-w-3xl">
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
export function AgentConsoleView({ mode, initialSessionId }: AgentConsoleViewProps) {
  const router = useRouter()
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot)
  const reuseQuery = useSearchParams().toString()
  const reuseKind = parseReuseKindQuery(reuseQuery)
  const { toast } = useToast()

  const storedSessionId = useAgentConsoleStore((state) => state.activeSessionId)
  const activeSessionId = initialSessionId ?? storedSessionId
  const leftSidebarOpen = useAgentConsoleStore((state) => state.leftSidebarOpen)
  const rightPanelOpen = useAgentConsoleStore((state) => state.rightPanelOpen)
  const rightPanelTab = useAgentConsoleStore((state) => state.rightPanelTab)
  const draftPrompt = useAgentConsoleStore((state) => state.draftPrompt)
  const definitionDraft = useAgentConsoleStore((state) => state.definitionDraft)

  const setActiveSessionId = useAgentConsoleStore((state) => state.setActiveSessionId)
  const toggleLeftSidebar = useAgentConsoleStore((state) => state.toggleLeftSidebar)
  const setLeftSidebarOpen = useAgentConsoleStore((state) => state.setLeftSidebarOpen)
  const toggleRightPanel = useAgentConsoleStore((state) => state.toggleRightPanel)
  const setRightPanelOpen = useAgentConsoleStore((state) => state.setRightPanelOpen)
  const setRightPanelTab = useAgentConsoleStore((state) => state.setRightPanelTab)
  const setDraftPrompt = useAgentConsoleStore((state) => state.setDraftPrompt)
  const consumeReuseQuery = useAgentConsoleStore((state) => state.consumeReuseQuery)
  const setDefinitionDraft = useAgentConsoleStore((state) => state.setDefinitionDraft)
  const resetForActor = useAgentConsoleStore((state) => state.resetForActor)

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    router.push(agentSessionRoute(id))
  }, [router, setActiveSessionId])

  useEffect(() => {
    if (initialSessionId) setActiveSessionId(initialSessionId)
  }, [initialSessionId, setActiveSessionId])

  const agentConsole = useAgentConsole(hydrated ? activeSessionId : null, { mode })

  const [newSessionOpen, setNewSessionOpen] = useState(false)
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
    const panel = parseInspectorPanelQuery(reuseQuery)
    if (panel) {
      setRightPanelTab(panel)
      setRightPanelOpen(true)
      if (!isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
    }
  }, [reuseQuery, consumeReuseQuery, setLeftSidebarOpen, setRightPanelTab, setRightPanelOpen])

  // 当已在 /generate 时再次点击顶部导航「任务与产物」，即使 URL query 未变也重新打开检查器。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOpenInspector = (event: Event) => {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel !== 'artifacts' && panel !== 'tools') return
      setRightPanelTab(panel)
      setRightPanelOpen(true)
      if (!isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
    }
    window.addEventListener('muse:open-inspector', onOpenInspector)
    return () => window.removeEventListener('muse:open-inspector', onOpenInspector)
  }, [setLeftSidebarOpen, setRightPanelTab, setRightPanelOpen])

  // 窄视口首屏折叠会以抽屉形态挂载的侧栏：<960px 收起左栏，<1280px（无 ?panel= 时）收起右栏。
  const viewportInitializedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || viewportInitializedRef.current || typeof window === 'undefined') return
    viewportInitializedRef.current = true
    if (!isDesktopLeftInline()) {
      setLeftSidebarOpen(false)
    }
    if (!isWideInspectorInline() && !parseInspectorPanelQuery(reuseQuery)) {
      setRightPanelOpen(false)
    }
  }, [hydrated, reuseQuery, setLeftSidebarOpen, setRightPanelOpen])

  // 抽屉形态侧栏打开时支持 Esc 关闭，且保留桌面内联侧栏。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return
    if (!leftSidebarOpen && !rightPanelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || newSessionOpen) return
      if (leftSidebarOpen && !isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
      if (rightPanelOpen && !isWideInspectorInline()) {
        setRightPanelOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    hydrated,
    leftSidebarOpen,
    rightPanelOpen,
    newSessionOpen,
    setLeftSidebarOpen,
    setRightPanelOpen,
  ])

  // Mock 模式首次加载自动选中内置演示会话，展示完整交互时间线。
  useEffect(() => {
    if (mode !== 'mock' || !hydrated) return
    if (activeSessionId !== null) return
    if (agentConsole.sessions.length === 0) return
    const seeded =
      agentConsole.sessions.find((session) => session.id === MOCK_SEED_SESSION_ID) ??
      agentConsole.sessions[0]
    if (seeded) selectSession(seeded.id)
  }, [mode, hydrated, activeSessionId, agentConsole.sessions, selectSession])

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
    if (!leftSidebarOpen && !isDesktopLeftInline()) {
      setRightPanelOpen(false)
    }
    toggleLeftSidebar()
  }

  function handleToggleRightPanel() {
    if (!rightPanelOpen && !isDesktopLeftInline()) {
      setLeftSidebarOpen(false)
    }
    toggleRightPanel()
  }

  return (
    <div
      data-workspace-mode={mode}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      {/* 抽屉遮罩：仅在当前视口存在以抽屉形态覆盖主画布的侧栏时显示（960px–1279px 仅右抽屉触发） */}
      {leftSidebarOpen || rightPanelOpen ? (
        <div
          aria-hidden="true"
          onClick={() => {
            if (!isDesktopLeftInline()) setLeftSidebarOpen(false)
            if (!isWideInspectorInline()) setRightPanelOpen(false)
          }}
          className={cn(
            'absolute inset-0 z-sticky bg-overlay/35 backdrop-blur-xs',
            rightPanelOpen ? 'lg:hidden' : 'md:hidden',
          )}
        />
      ) : null}

      {/* 左栏：会话列表（>=960px 内联停靠，<960px 抽屉；始终挂载以承载新建会话 Dialog） */}
      <aside
        aria-label="Agent 会话侧栏"
        className={cn(
          'absolute inset-y-0 left-0 z-sticky w-72 max-w-[85vw] border-r border-border/70 bg-surface/95 backdrop-blur-md shadow-drawer',
          'md:static md:inset-y-auto md:z-auto md:h-full md:w-64 md:max-w-none md:shrink-0 md:bg-surface/60 md:backdrop-blur-none md:shadow-none lg:w-72',
          !leftSidebarOpen && 'hidden',
        )}
      >
        <SessionSidebar
          console={agentConsole}
          activeSessionId={activeSessionId}
          onSelectSession={selectSession}
          definitionDraft={definitionDraft}
          onUpdateDefinitionDraft={setDefinitionDraft}
          newSessionOpen={newSessionOpen}
          onOpenNewSession={() => setNewSessionOpen(true)}
          onCloseNewSession={() => setNewSessionOpen(false)}
          onCloseMobile={() => {
            if (!isDesktopLeftInline()) {
              setLeftSidebarOpen(false)
            }
          }}
        />
      </aside>

      {/* 中栏：轻量化顶栏 + 执行时间线 + 悬浮交互输入器 */}
      <section aria-label="Agent 执行控制台" className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-canvas/85 px-3 backdrop-blur-sm sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label={leftSidebarOpen ? '收起会话列表' : '展开会话列表'}
              aria-expanded={leftSidebarOpen}
              onClick={handleToggleLeftSidebar}
              icon={<SidebarSimpleIcon className={iconSize.md} aria-hidden="true" />}
            />

            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  'truncate text-ui font-medium',
                  agentConsole.session ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {agentConsole.session
                  ? '当前会话'
                  : activeSessionId
                    ? '加载会话中…'
                    : '新会话'}
              </span>

              {inlineStatus ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={cn('size-1.5 shrink-0 rounded-pill', STATUS_DOT_TONES[inlineStatus.tone])}
                  />
                  <span className="truncate">{inlineStatus.label}</span>
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              aria-label="刷新"
              className="rounded-pill"
              disabled={!agentConsole.sessionId}
              loading={agentConsole.connectionState === 'resyncing'}
              onClick={() => void agentConsole.resync()}
              icon={<ArrowClockwiseIcon className={iconSize.sm} aria-hidden="true" />}
            >
              <span className="hidden sm:inline">刷新</span>
            </Button>

            <Button
              size="sm"
              variant={rightPanelOpen ? 'secondary' : 'ghost'}
              className="rounded-pill"
              aria-label={
                pendingApprovalCount > 0
                  ? `${rightPanelOpen ? '收起' : '展开'}检查器面板（${pendingApprovalCount} 项待审批）`
                  : rightPanelOpen
                    ? '收起检查器面板'
                    : '展开检查器面板'
              }
              aria-expanded={rightPanelOpen}
              onClick={handleToggleRightPanel}
              icon={<SlidersHorizontalIcon className={iconSize.sm} aria-hidden="true" />}
            >
              <span className="hidden sm:inline">
                {pendingApprovalCount > 0 ? `检查器 (${pendingApprovalCount})` : '检查器'}
              </span>
              {pendingApprovalCount > 0 ? (
                <span className="text-caption font-medium sm:hidden">
                  ({pendingApprovalCount})
                </span>
              ) : null}
            </Button>
          </div>
        </header>

        <ExecutionTimeline
          console={agentConsole}
          onOpenNewSession={() => setNewSessionOpen(true)}
          onReusePrompt={(prompt) => {
            setDraftPrompt(prompt)
            toast.info('已填入提示词草稿', '可在下方输入区编辑后发送')
          }}
          onResolveApproval={handleResolveApproval}
          resolvingApproval={resolvingApproval}
          approvalErrors={approvalErrors}
        />

        <AgentComposer
          console={agentConsole}
          draftPrompt={draftPrompt}
          onChangeDraft={setDraftPrompt}
          reuseKind={reuseKind}
          onOpenNewSession={() => setNewSessionOpen(true)}
        />
      </section>

      {/* 右栏：检查器面板（>=1280px 内联停靠，<1280px 右缘抽屉） */}
      <aside
        aria-label="Agent 检查器面板"
        className={cn(
          'absolute inset-y-0 right-0 z-sticky w-88 max-w-[92vw] border-l border-border/80 bg-surface/95 backdrop-blur-md shadow-drawer',
          'lg:static lg:inset-y-auto lg:z-auto lg:h-full lg:w-88 lg:max-w-none lg:shrink-0 lg:backdrop-blur-none lg:shadow-none',
          !rightPanelOpen && 'hidden',
        )}
      >
        <InspectorPanel
          console={agentConsole}
          activeTab={rightPanelTab}
          onChangeTab={setRightPanelTab}
          onReusePrompt={(prompt) => {
            setDraftPrompt(prompt)
            toast.info('已填入提示词草稿', '可在下方输入区编辑后发送')
          }}
          onResolveApproval={handleResolveApproval}
          resolvingApproval={resolvingApproval}
          approvalErrors={approvalErrors}
        />
      </aside>
    </div>
  )
}
