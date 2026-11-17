'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  PaperPlaneTiltIcon,
  PlusIcon,
  StopCircleIcon,
} from '@phosphor-icons/react'
import { Alert, Button, iconSize } from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { cn } from '@/shared/lib/cn'
import {
  AGENT_MESSAGE_MAX_BYTES,
  isMessageOverLimit,
  utf8ByteLength,
} from '../lib/agent-status'

export interface AgentComposerProps {
  console: AgentConsoleController
  draftPrompt: string
  onChangeDraft: (value: string) => void
  reuseKind?: string | null
  onOpenNewSession: () => void
}

const COMPOSER_MIN_HEIGHT_PX = 44
const COMPOSER_MAX_HEIGHT_PX = 192

/**
 * 底部悬浮交互输入器：支持发起消息、进行中轮次 Steer 追加引导、停止轮次，
 * 以及自适应文本高度、UTF-8 字节计数守卫与失败保留草稿。
 */
export function AgentComposer({
  console: agentConsole,
  draftPrompt,
  onChangeDraft,
  onOpenNewSession,
}: AgentComposerProps) {
  const {
    sessionId,
    activeTurn,
    turnActive,
    serviceStatus,
    sendMessage,
    steerTurn,
    cancelTurn,
    mutations,
  } = agentConsole

  const [submitError, setSubmitError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const byteCount = utf8ByteLength(draftPrompt)
  const overLimit = isMessageOverLimit(draftPrompt, AGENT_MESSAGE_MAX_BYTES)
  const showByteCount = overLimit || byteCount > 24_000
  const trimmed = draftPrompt.trim()
  const isDisabledService = serviceStatus === 'disabled_404'
  const isCancelling = Boolean(turnActive && activeTurn?.cancelRequestedAt)
  const isSending = mutations.sendMessage.isPending || mutations.steerTurn.isPending
  const isCancellingMutation = mutations.cancelTurn.isPending

  const canSubmit =
    Boolean(sessionId) &&
    trimmed.length > 0 &&
    !overLimit &&
    !isDisabledService &&
    !isCancelling &&
    !isSending

  // 随输入内容自动伸缩高度（44px ~ 192px），避免 resize-y 拖曳角破坏悬浮卡片轮廓。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const nextHeight = Math.min(
      Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT_PX),
      COMPOSER_MAX_HEIGHT_PX,
    )
    el.style.height = `${nextHeight}px`
  }, [draftPrompt])

  async function executeSubmit() {
    if (!canSubmit || submittingRef.current || !sessionId) return
    submittingRef.current = true
    setSubmitError(null)
    try {
      if (turnActive && activeTurn) {
        await steerTurn({ turnId: activeTurn.id, content: draftPrompt })
      } else {
        await sendMessage({ sessionId, content: draftPrompt })
      }
      // 仅在后端/模拟引擎明确受理后才清空草稿；失败时保留用户输入。
      onChangeDraft('')
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '指令发送失败，草稿已保留，请重试。',
      )
    } finally {
      submittingRef.current = false
    }
  }

  async function handleCancelTurn() {
    if (!activeTurn || isCancelling || isCancellingMutation) return
    setSubmitError(null)
    try {
      await cancelTurn(activeTurn.id)
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '取消轮次失败，请刷新状态后重试。',
      )
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void executeSubmit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void executeSubmit()
    }
  }

  return (
    <div className="relative shrink-0 bg-gradient-to-t from-canvas via-canvas/95 to-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6">
      <form
        onSubmit={handleFormSubmit}
        className="mx-auto flex w-full max-w-3xl flex-col gap-2"
        noValidate
      >
        {submitError ? (
          <Alert tone="danger" role="alert" onDismiss={() => setSubmitError(null)}>
            {submitError}
          </Alert>
        ) : null}

        <div
          className={cn(
            'flex flex-col gap-2 rounded-panel border bg-surface px-4 pb-3 pt-3.5 shadow-floating transition-[border-color,box-shadow] focus-within:shadow-modal',
            overLimit
              ? 'border-danger focus-within:border-danger'
              : 'border-border focus-within:border-border-focus',
          )}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={draftPrompt}
            disabled={isDisabledService}
            aria-invalid={overLimit || undefined}
            aria-label="输入 Agent 指令"
            placeholder="输入创作需求或执行目标…"
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              onChangeDraft(event.target.value)
              if (submitError) setSubmitError(null)
            }}
            className="min-h-11 max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-compact leading-relaxed text-foreground placeholder:text-decorative-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {overLimit ? (
                <span className="text-caption text-danger">
                  已超出 32,000 字节上限
                </span>
              ) : null}
              {showByteCount ? (
                <span
                  className={cn(
                    'font-mono text-caption',
                    overLimit ? 'font-medium text-danger' : 'text-muted-foreground',
                  )}
                >
                  {byteCount} / {AGENT_MESSAGE_MAX_BYTES} B
                </span>
              ) : !sessionId && !isDisabledService ? (
                <span className="text-caption text-muted-foreground">
                  未选中会话
                </span>
              ) : turnActive ? (
                <span className="text-caption text-muted-foreground">
                  {isCancelling ? '正在请求停止…' : '运行中 · 可发送引导或停止'}
                </span>
              ) : (
                <span className="hidden text-caption text-decorative-muted sm:inline">
                  Ctrl + Enter 发送
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!sessionId && !isDisabledService ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-pill"
                  onClick={onOpenNewSession}
                  icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                >
                  新建会话
                </Button>
              ) : null}

              {turnActive && activeTurn ? (
                <>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    className="rounded-pill"
                    disabled={isCancelling || isCancellingMutation}
                    loading={isCancellingMutation}
                    onClick={() => void handleCancelTurn()}
                    icon={<StopCircleIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    {isCancelling ? '停止中' : '停止'}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    className="rounded-pill"
                    disabled={!canSubmit}
                    loading={isSending}
                    icon={<PaperPlaneTiltIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    追加引导
                  </Button>
                </>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  className="rounded-pill"
                  disabled={!canSubmit}
                  loading={isSending}
                  icon={<PaperPlaneTiltIcon className={iconSize.sm} aria-hidden="true" />}
                >
                  发送
                </Button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
