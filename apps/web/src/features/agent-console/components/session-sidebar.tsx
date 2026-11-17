'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ChatCircleDotsIcon,
  PlusIcon,
  RobotIcon,
} from '@phosphor-icons/react'
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  SkeletonRow,
  useToast,
  iconSize,
} from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { cn } from '@/shared/lib/cn'
import { formatRelativeTime } from '@/shared/lib/format'
import { MOCK_AGENT_DEFINITION_ID } from '@/shared/services/mock-agent-api'
import {
  deriveSessionStatus,
  isValidUuid,
  shortUuid,
} from '../lib/agent-status'
import type { AgentDefinitionDraft } from '../stores/agent-console-store'

export interface SessionSidebarProps {
  console: AgentConsoleController
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  definitionDraft: AgentDefinitionDraft
  onUpdateDefinitionDraft: (patch: Partial<AgentDefinitionDraft>) => void
  newSessionOpen: boolean
  onOpenNewSession: () => void
  onCloseNewSession: () => void
  onCloseMobile?: () => void
}

interface NewSessionFormState {
  agentDefinitionId: string
  definitionVersion: string
}

/**
 * 左侧可折叠会话列表栏与新建会话弹窗。
 * 仅消费 `useAgentConsole` 暴露的会话列表与 `createSession` 动作，不持有服务端数据副本。
 */
export function SessionSidebar({
  console: agentConsole,
  activeSessionId,
  onSelectSession,
  definitionDraft,
  onUpdateDefinitionDraft,
  newSessionOpen,
  onOpenNewSession,
  onCloseNewSession,
  onCloseMobile,
}: SessionSidebarProps) {
  const { toast } = useToast()
  const [formState, setFormState] = useState<NewSessionFormState>(() => ({
    agentDefinitionId:
      agentConsole.mode === 'mock'
        ? definitionDraft.agentDefinitionId || MOCK_AGENT_DEFINITION_ID
        : definitionDraft.agentDefinitionId,
    definitionVersion: String(definitionDraft.definitionVersion || 1),
  }))
  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const isDisabledService = agentConsole.serviceStatus === 'disabled_404'
  const creating = agentConsole.mutations.createSession.isPending
  const previousOpenRef = useRef(false)

  useEffect(() => {
    if (newSessionOpen && !previousOpenRef.current) {
      setFormState({
        agentDefinitionId:
          agentConsole.mode === 'mock'
            ? definitionDraft.agentDefinitionId || MOCK_AGENT_DEFINITION_ID
            : definitionDraft.agentDefinitionId,
        definitionVersion: String(definitionDraft.definitionVersion || 1),
      })
      setFormError(null)
      setSubmitError(null)
    }
    previousOpenRef.current = newSessionOpen
  }, [newSessionOpen, agentConsole.mode, definitionDraft])

  function handleOpenDialog() {
    onOpenNewSession()
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating || isDisabledService) return

    const definitionId = formState.agentDefinitionId.trim()
    const versionNumber = Number(formState.definitionVersion)

    if (!isValidUuid(definitionId)) {
      setFormError('请输入合法的 Agent Definition UUID（如 00000000-0000-4000-8000-000000000201）。')
      return
    }
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      setFormError('定义版本必须是大于等于 1 的整数。')
      return
    }

    setFormError(null)
    setSubmitError(null)

    const normalizedDefinitionId = definitionId.toLowerCase()

    try {
      const created = await agentConsole.createSession({
        agentDefinitionId: normalizedDefinitionId,
        definitionVersion: versionNumber,
      })
      onUpdateDefinitionDraft({
        agentDefinitionId: normalizedDefinitionId,
        definitionVersion: versionNumber,
      })
      onSelectSession(created.id)
      onCloseNewSession()
      onCloseMobile?.()
      toast.success('Agent 会话已创建', `会话 ${shortUuid(created.id)} 已就绪`)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '创建会话失败，请检查参数或服务状态。')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-ui font-semibold text-foreground">会话</h2>
          {agentConsole.sessions.length > 0 ? (
            <span className="text-caption tabular-nums text-muted-foreground">
              ({agentConsole.sessions.length})
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="rounded-pill"
          disabled={isDisabledService}
          onClick={handleOpenDialog}
          icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
        >
          新建
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {agentConsole.sessionsQuery.isPending ? (
          <div aria-busy="true" aria-label="正在加载会话列表" className="space-y-2.5 p-1">
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
          </div>
        ) : agentConsole.sessions.length === 0 ? (
          <EmptyState
            density="compact"
            icon={ChatCircleDotsIcon}
            title={
              agentConsole.serviceStatus === 'disabled_404'
                ? 'Agent Core 未启用'
                : agentConsole.serviceStatus === 'admission_closed_503'
                  ? '执行准入暂未就绪'
                  : agentConsole.serviceStatus === 'error'
                    ? '会话列表加载失败'
                    : '暂无 Agent 会话'
            }
            description={
              agentConsole.serviceStatus === 'disabled_404'
                ? '后端配置关闭了 Agent Core V1（404），暂时无法列出或创建会话。'
                : agentConsole.serviceStatus === 'admission_closed_503'
                  ? '后端异步准入通道暂不可用（503），请稍后重试检查。'
                  : agentConsole.serviceStatus === 'error'
                    ? agentConsole.error?.message ?? '请检查网络连接后重试。'
                    : '点击上方「新建」按钮绑定 Agent 定义，开启多轮协作对话。'
            }
            action={
              agentConsole.serviceStatus === 'admission_closed_503' ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-pill"
                    onClick={() => agentConsole.reconnect()}
                  >
                    重新检查
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="rounded-pill"
                    onClick={handleOpenDialog}
                    icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    新建会话
                  </Button>
                </div>
              ) : agentConsole.serviceStatus === 'error' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-pill"
                  onClick={() => void agentConsole.sessionsQuery.refetch()}
                >
                  重试
                </Button>
              ) : agentConsole.serviceStatus === 'ready' ? (
                <Button
                  size="sm"
                  variant="primary"
                  className="rounded-pill"
                  onClick={handleOpenDialog}
                  icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                >
                  新建会话
                </Button>
              ) : null
            }
          />
        ) : (
          <ul className="space-y-1.5" role="list" aria-label="Agent 会话列表">
            {agentConsole.sessions.map((session) => {
              const selected = session.id === activeSessionId
              const status = deriveSessionStatus(session)
              const isRunning = status === 'active'
              const statusLabel =
                status === 'active' ? '运行中' : status === 'archived' ? '已归档' : null

              return (
                <li key={session.id}>
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => {
                      onSelectSession(session.id)
                      onCloseMobile?.()
                    }}
                    className={cn(
                      'flex w-full min-w-0 flex-col gap-1 rounded-card border px-3 py-2.5 text-left transition-colors',
                      selected
                        ? 'border-border/80 bg-surface text-foreground shadow-soft'
                        : 'border-transparent bg-transparent text-foreground/90 hover:bg-surface/60 hover:text-foreground',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isRunning ? (
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 animate-pulse rounded-pill bg-accent"
                        />
                      ) : null}
                      <span className="truncate text-ui font-medium">
                        对话 {shortUuid(session.id)}
                      </span>
                    </div>

                    <div className="flex min-w-0 items-center justify-between gap-2 text-caption text-muted-foreground">
                      <span className="truncate">{formatRelativeTime(session.updatedAt)}</span>
                      {statusLabel ? (
                        <span
                          className={cn(
                            'shrink-0',
                            isRunning ? 'font-medium text-accent' : 'text-muted-foreground',
                          )}
                        >
                          {statusLabel}
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {agentConsole.hasMoreSessions ? (
          <div className="pt-3">
            <Button
              size="sm"
              variant="ghost"
              fullWidth
              className="rounded-pill"
              loading={agentConsole.sessionsQuery.isFetchingNextPage}
              onClick={() => agentConsole.loadMoreSessions()}
            >
              加载更多会话
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={newSessionOpen}
        onClose={() => {
          if (!creating) onCloseNewSession()
        }}
        title="新建 Agent 会话"
        description="绑定 Agent 定义，会话创建后可立即下发多轮指令。"
        initialFocus="first-input"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={onCloseNewSession}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="create-agent-session-form"
              loading={creating}
              disabled={isDisabledService}
              icon={<RobotIcon className={iconSize.sm} aria-hidden="true" />}
            >
              创建会话
            </Button>
          </>
        }
      >
        <form
          id="create-agent-session-form"
          onSubmit={(event) => void handleCreateSubmit(event)}
          className="space-y-4"
          noValidate
        >
          {agentConsole.mode === 'live' ? (
            <Alert tone="info" title="填写已有 Agent Definition UUID">
              当前阶段后端尚未暴露 <code>GET /api/agent/definitions</code> 目录端点，请输入已配置的 Agent 定义 UUID（系统会自动记住上次输入）。
            </Alert>
          ) : (
            <Alert tone="info" title="本地演示预设">
              Mock 模式已预填本地示例定义，可直接创建体验多轮会话流。
            </Alert>
          )}

          <Field
            label="Agent Definition ID"
            required
            hint="标准 UUID 格式（如 00000000-0000-4000-8000-000000000201）"
          >
            <Input
              value={formState.agentDefinitionId}
              placeholder="00000000-0000-4000-8000-000000000201"
              className="font-mono text-ui"
              disabled={creating}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, agentDefinitionId: event.target.value }))
                setFormError(null)
              }}
            />
          </Field>

          <Field label="定义版本（definitionVersion）" required hint="正整数，默认 1">
            <Input
              type="number"
              min={1}
              step={1}
              value={formState.definitionVersion}
              disabled={creating}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, definitionVersion: event.target.value }))
                setFormError(null)
              }}
            />
          </Field>

          {formError ? (
            <Alert tone="danger" role="alert">
              {formError}
            </Alert>
          ) : null}
          {submitError ? (
            <Alert tone="danger" role="alert" title="无法创建会话">
              {submitError}
            </Alert>
          ) : null}
        </form>
      </Dialog>
    </div>
  )
}
