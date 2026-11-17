'use client'

import { useId, useState } from 'react'
import {
  CaretDownIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ImageIcon,
  MagicWandIcon,
  PlusIcon,
  ShieldWarningIcon,
  SparkleIcon,
  TerminalWindowIcon,
  WrenchIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import type {
  AgentApprovalSummaryDTO,
  AgentItemDTO,
  AgentToolSummaryDTO,
} from '@musecanvas/contracts'
import {
  Alert,
  Button,
  EmptyState,
  Skeleton,
  SkeletonText,
  Spinner,
  iconSize,
  type BadgeTone,
} from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { cn } from '@/shared/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/shared/lib/format'
import {
  extractArtifactPreview,
  extractItemText,
  extractToolPayloadInfo,
  formatAgentErrorCode,
  formatApprovalStatus,
  formatToolStatus,
  formatTurnStatus,
  isSafeDisplayUrl,
} from '../lib/agent-status'

const STATUS_TEXT_TONE: Record<BadgeTone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent',
}

export interface ExecutionTimelineProps {
  console: AgentConsoleController
  onOpenNewSession: () => void
  onReusePrompt: (prompt: string) => void
  onResolveApproval: (
    approval: AgentApprovalSummaryDTO,
    decision: 'approved' | 'rejected',
  ) => Promise<void>
  resolvingApproval: { id: string; decision: 'approved' | 'rejected' } | null
  approvalErrors: Record<string, string>
}

interface ApprovalCardProps {
  approval: AgentApprovalSummaryDTO | null
  toolName: string | null
  summaryText: string
  createdAt: string
  disabledService: boolean
  resolvingDecision: 'approved' | 'rejected' | null
  errorMessage?: string
  onResolve: (approval: AgentApprovalSummaryDTO, decision: 'approved' | 'rejected') => Promise<void>
}

function ApprovalCard({
  approval,
  toolName,
  summaryText,
  createdAt,
  disabledService,
  resolvingDecision,
  errorMessage,
  onResolve,
}: ApprovalCardProps) {
  const statusMeta = approval
    ? formatApprovalStatus(approval.status)
    : { label: '历史审批记录', tone: 'neutral' as const }
  const isPending = approval?.status === 'pending' && !disabledService
  const busy = resolvingDecision !== null
  const timeMeta = approval
    ? approval.status === 'pending'
      ? `有效期至 ${formatDateTime(approval.expiresAt)}`
      : approval.resolvedAt
        ? `${formatRelativeTime(approval.resolvedAt)}处理`
        : `有效期至 ${formatDateTime(approval.expiresAt)}`
    : formatRelativeTime(createdAt)

  return (
    <article
      aria-label="工具执行审批"
      className={cn(
        'w-full rounded-panel border p-4',
        isPending
          ? 'border-warning-border bg-warning-soft/45 sm:p-5'
          : 'border-border/75 bg-surface/80',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-control',
            isPending ? 'bg-warning-soft text-warning' : 'bg-tonal text-muted-foreground',
          )}
        >
          <ShieldWarningIcon className={iconSize.sm} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground">
            {toolName ? `审批请求 · ${toolName}` : '工具执行审批'}
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {timeMeta}
            {' · '}
            <span className={cn('font-medium', STATUS_TEXT_TONE[statusMeta.tone])}>
              {statusMeta.label}
            </span>
          </p>
        </div>
      </div>

      {summaryText ? (
        <p className="mt-2.5 whitespace-pre-wrap break-words text-ui leading-relaxed text-foreground">
          {summaryText}
        </p>
      ) : null}

      {errorMessage ? (
        <Alert tone="danger" role="alert" className="mt-3">
          {errorMessage}
        </Alert>
      ) : null}

      {isPending && approval ? (
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-warning-border/60 pt-3">
          <Button
            size="sm"
            variant="danger-ghost"
            className="rounded-pill"
            disabled={busy}
            loading={resolvingDecision === 'rejected'}
            onClick={() => void onResolve(approval, 'rejected')}
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
            onClick={() => void onResolve(approval, 'approved')}
            icon={<CheckCircleIcon className={iconSize.sm} aria-hidden="true" />}
          >
            批准执行
          </Button>
        </div>
      ) : null}
    </article>
  )
}

function AssistantMessageCard({ item }: { item: AgentItemDTO }) {
  const [copied, setCopied] = useState(false)
  const text = extractItemText(item)

  async function handleCopy() {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // 剪贴板权限受限时静默忽略，不打断浏览。
    }
  }

  return (
    <article className="group w-full">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-caption">
          <SparkleIcon
            className={cn(iconSize.sm, 'shrink-0 text-accent')}
            weight="duotone"
            aria-hidden="true"
          />
          <span className="font-medium text-foreground">MuseCanvas</span>
          <span className="truncate text-muted-foreground">· {formatRelativeTime(item.createdAt)}</span>
        </div>
        {text ? (
          <button
            type="button"
            aria-label={copied ? '已复制回复' : '复制回复内容'}
            onClick={() => void handleCopy()}
            className={cn(
              'inline-flex min-h-7 shrink-0 items-center gap-1 rounded-control px-2 text-caption transition-colors',
              copied
                ? 'text-foreground'
                : 'text-muted-foreground opacity-80 hover:bg-tonal/70 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            {copied ? (
              <CheckIcon className={iconSize.xs} aria-hidden="true" />
            ) : (
              <CopyIcon className={iconSize.xs} aria-hidden="true" />
            )}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        ) : null}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-compact leading-relaxed text-foreground">
        {text || '（无文本正文）'}
      </p>
    </article>
  )
}

function ArtifactReferenceCard({
  item,
  onReusePrompt,
}: {
  item: AgentItemDTO
  onReusePrompt: (prompt: string) => void
}) {
  const [imageError, setImageError] = useState(false)
  const preview = extractArtifactPreview(item)
  const candidateUrl = preview.thumbnailUrl || preview.url
  const safeImageUrl = isSafeDisplayUrl(candidateUrl) ? candidateUrl : null
  const captionTitle =
    preview.label && preview.message && !preview.message.includes(preview.label)
      ? `${preview.label} · ${preview.message}`
      : preview.message || (preview.label ? `产物参考 · ${preview.label}` : '生成产物参考')

  return (
    <article
      className={cn(
        'w-full',
        safeImageUrl
          ? 'space-y-2.5'
          : 'space-y-2 rounded-card border border-border/70 bg-surface/75 px-4 py-3',
      )}
    >
      {safeImageUrl && !imageError ? (
        <div className="inline-flex max-w-full overflow-hidden rounded-card border border-border/80 bg-tonal shadow-soft">
          <img
            src={safeImageUrl}
            alt={preview.prompt || preview.label || 'Agent 产物预览'}
            loading="lazy"
            onError={() => setImageError(true)}
            className="block max-h-96 w-auto max-w-full object-contain"
          />
        </div>
      ) : safeImageUrl && imageError ? (
        <div className="inline-flex max-w-full items-center gap-2 rounded-card border border-border/70 bg-tonal/60 px-3.5 py-2.5 text-caption text-muted-foreground">
          <ImageIcon className={cn(iconSize.sm, 'shrink-0')} aria-hidden="true" />
          <span>预览图暂不可用</span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
            {!safeImageUrl ? (
              <ImageIcon className={cn(iconSize.sm, 'shrink-0 text-accent')} aria-hidden="true" />
            ) : null}
            <span className="font-medium text-foreground">{captionTitle}</span>
            {preview.width && preview.height ? (
              <span>· {preview.width}×{preview.height}</span>
            ) : null}
            <span>· {formatRelativeTime(item.createdAt)}</span>
          </div>

          {preview.prompt ? (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-pill px-2.5 text-caption text-muted-foreground hover:text-foreground"
              onClick={() => onReusePrompt(preview.prompt!)}
              icon={<MagicWandIcon className={iconSize.xs} aria-hidden="true" />}
            >
              复用提示词
            </Button>
          ) : null}
        </div>

        {preview.prompt ? (
          <p className="break-words text-caption leading-relaxed text-muted-foreground">
            提示词：{preview.prompt}
          </p>
        ) : null}
      </div>
    </article>
  )
}

function ToolTraceCard({
  item,
  toolSummary,
}: {
  item: AgentItemDTO
  toolSummary: AgentToolSummaryDTO | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const payloadId = useId()
  const payloadInfo = extractToolPayloadInfo(item)
  const isResult = item.type === 'tool_result'
  const toolName = toolSummary?.toolName ?? payloadInfo.toolName ?? (isResult ? '工具结果' : '工具调用')
  const status =
    toolSummary?.status ?? payloadInfo.status ?? (isResult ? 'completed' : 'recorded')
  const statusMeta = formatToolStatus(status)
  const detailText = payloadInfo.error ?? payloadInfo.message
  const Icon = isResult ? TerminalWindowIcon : WrenchIcon

  return (
    <article className="w-full rounded-card border border-border/70 bg-surface/75 px-3.5 py-2.5 transition-colors hover:bg-surface">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={payloadId}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full min-w-0 items-center justify-between gap-3 rounded-control text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className={cn(iconSize.sm, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
          <span className="max-w-44 shrink-0 truncate text-ui font-medium text-foreground sm:max-w-none">
            {toolName}
          </span>
          {!expanded && detailText ? (
            <span className="min-w-0 truncate text-caption text-muted-foreground">
              {detailText}
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <span className={cn('text-caption font-medium', STATUS_TEXT_TONE[statusMeta.tone])}>
            {statusMeta.label}
          </span>
          <span className="hidden text-caption text-muted-foreground sm:inline">
            {formatRelativeTime(item.createdAt)}
          </span>
          <CaretDownIcon
            className={cn(
              iconSize.xs,
              'shrink-0 text-muted-foreground transition-transform duration-(--motion-fast) motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </span>
      </button>

      {expanded ? (
        <div id={payloadId} className="mt-2.5 border-t border-border/60 pt-2.5">
          {detailText ? (
            <p className="mb-2 break-words text-caption leading-relaxed text-muted-foreground">
              {detailText}
            </p>
          ) : null}
          <p className="mb-2 text-caption text-muted-foreground sm:hidden">
            {formatRelativeTime(item.createdAt)}
          </p>
          <pre className="max-h-56 overflow-auto rounded-control border border-border/70 bg-canvas p-2.5 font-mono text-caption text-foreground">
            {JSON.stringify(item.payload, null, 2)}
          </pre>
        </div>
      ) : null}
    </article>
  )
}

/**
 * 中央执行时间线：按 sequence 升序展示会话项、工具调用与内联审批，
 * 并负责 404/503 服务边界横幅及活跃轮次进度指示。
 */
export function ExecutionTimeline({
  console: agentConsole,
  onOpenNewSession,
  onReusePrompt,
  onResolveApproval,
  resolvingApproval,
  approvalErrors,
}: ExecutionTimelineProps) {
  const {
    serviceStatus,
    sessionId,
    items,
    timeline,
    activeTurn,
    turnActive,
    pendingApprovals,
    snapshotQuery,
    hasOlderItems,
    loadingOlderItems,
    loadOlderError,
    loadOlderItems,
    reconnect,
    resync,
    error,
  } = agentConsole

  const approvalsList = Object.values(timeline.approvals)
  const renderedApprovalIds = new Set<string>()
  const disabledService = serviceStatus === 'disabled_404'

  function findApprovalForItem(item: AgentItemDTO): AgentApprovalSummaryDTO | null {
    const info = extractToolPayloadInfo(item)
    if (info.approvalId && timeline.approvals[info.approvalId]) {
      return timeline.approvals[info.approvalId]!
    }
    if (item.toolCallId) {
      const matched = approvalsList.find((candidate) => candidate.toolCallId === item.toolCallId)
      if (matched) return matched
    }
    return null
  }

  for (const item of items) {
    if (item.type === 'approval') {
      const matched = findApprovalForItem(item)
      if (matched) renderedApprovalIds.add(matched.id)
    }
  }

  const unrenderedPendingApprovals = pendingApprovals.filter(
    (approval) => !renderedApprovalIds.has(approval.id),
  )

  const activeTurnMeta =
    turnActive && activeTurn
      ? formatTurnStatus(activeTurn.status, {
          cancelRequestedAt: activeTurn.cancelRequestedAt,
          errorCode: activeTurn.error?.code,
        })
      : null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6 sm:px-6 [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {serviceStatus === 'disabled_404' ? (
          <Alert tone="warning" title="Agent Core 服务未启用（404）">
            当前后端配置关闭了 Agent Core V1（<code>AGENT_CORE_ENABLED=false</code>），控制台无法创建会话或发起执行。
          </Alert>
        ) : null}

        {serviceStatus === 'admission_closed_503' ? (
          <Alert
            tone="warning"
            title="执行队列准入暂未就绪（503）"
            action={
              <Button size="sm" variant="secondary" onClick={reconnect}>
                重新检查
              </Button>
            }
          >
            后端控制面检测到异步执行通道未就绪（<code>AGENT_CORE_ADMISSION_READY=false</code>），请等待管理员启用或稍后重试。
          </Alert>
        ) : null}

        {serviceStatus === 'error' && error ? (
          <Alert
            tone="danger"
            role="alert"
            title="控制台同步异常"
            action={
              <Button size="sm" variant="secondary" onClick={() => void resync()}>
                重试同步
              </Button>
            }
          >
            {error.message}
          </Alert>
        ) : null}

        {timeline.resyncRequired ? (
          <Alert tone="info" title="事件流重同步中">
            检测到事件流滞后（{timeline.resyncRequired}），正在拉取最新会话快照。
          </Alert>
        ) : null}

        {!sessionId ? (
          <div className="rounded-panel border border-border/70 bg-surface/70 p-8">
            <EmptyState
              icon={SparkleIcon}
              title="选择或新建 Agent 会话"
              description={
                disabledService
                  ? 'Agent Core V1 尚未在服务端启用，请等待管理员配置开启后再试。'
                  : '从左侧会话列表选择一个已有对话，或点击新建绑定 Agent 定义开始执行。'
              }
              action={
                !disabledService ? (
                  <Button
                    variant="primary"
                    className="rounded-pill"
                    onClick={onOpenNewSession}
                    icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    新建会话
                  </Button>
                ) : null
              }
            />
          </div>
        ) : snapshotQuery.isPending ? (
          <div aria-busy="true" aria-label="正在加载执行时间线" className="space-y-5 py-2">
            <Skeleton className="ml-auto h-14 w-2/3 rounded-panel" />
            <div className="py-1">
              <SkeletonText lines={3} />
            </div>
            <Skeleton className="h-16 w-full rounded-card" />
          </div>
        ) : (
          <>
            {items.length === 0 && !turnActive && unrenderedPendingApprovals.length === 0 ? (
              <div className="rounded-panel border border-border/70 bg-surface/70 p-8">
                <EmptyState
                  density="compact"
                  icon={SparkleIcon}
                  title="等待首条指令"
                  description="在下方输入你的创作需求或执行目标，Agent 会按步骤规划、发起工具审批并产出结果。"
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-5" role="log" aria-label="Agent 执行时间线">
              {items.map((item) => {
                if (item.type === 'user_message') {
                  return (
                    <article
                      key={item.id}
                      className="ml-auto max-w-[82%] rounded-panel rounded-br-control bg-tonal px-4 py-2.5 text-compact leading-relaxed text-foreground sm:max-w-[75%]"
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {extractItemText(item)}
                      </p>
                      <p className="mt-1 text-right text-caption text-muted-foreground">
                        {formatRelativeTime(item.createdAt)}
                      </p>
                    </article>
                  )
                }

                if (item.type === 'assistant_message') {
                  return <AssistantMessageCard key={item.id} item={item} />
                }

                if (item.type === 'tool_call' || item.type === 'tool_result') {
                  const matchedTool = item.toolCallId
                    ? timeline.tools[item.toolCallId]
                    : undefined
                  return <ToolTraceCard key={item.id} item={item} toolSummary={matchedTool} />
                }

                if (item.type === 'approval') {
                  const matchedApproval = findApprovalForItem(item)
                  const matchedTool = item.toolCallId
                    ? timeline.tools[item.toolCallId]
                    : undefined
                  const payloadInfo = extractToolPayloadInfo(item)
                  const resolvingDecision =
                    matchedApproval && resolvingApproval?.id === matchedApproval.id
                      ? resolvingApproval.decision
                      : null

                  return (
                    <ApprovalCard
                      key={item.id}
                      approval={matchedApproval}
                      toolName={matchedTool?.toolName ?? payloadInfo.toolName}
                      summaryText={extractItemText(item)}
                      createdAt={item.createdAt}
                      disabledService={disabledService}
                      resolvingDecision={resolvingDecision}
                      errorMessage={matchedApproval ? approvalErrors[matchedApproval.id] : undefined}
                      onResolve={onResolveApproval}
                    />
                  )
                }

                if (item.type === 'artifact_reference') {
                  return (
                    <ArtifactReferenceCard
                      key={item.id}
                      item={item}
                      onReusePrompt={onReusePrompt}
                    />
                  )
                }

                // system_event
                return (
                  <div key={item.id} className="flex items-center gap-3 py-1">
                    <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                    <span className="inline-flex max-w-full items-center gap-1.5 text-caption text-muted-foreground">
                      <span className="truncate">{extractItemText(item)}</span>
                      <span className="shrink-0">· {formatRelativeTime(item.createdAt)}</span>
                    </span>
                    <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                  </div>
                )
              })}

              {unrenderedPendingApprovals.map((approval) => {
                const matchedTool = timeline.tools[approval.toolCallId]
                const resolvingDecision =
                  resolvingApproval?.id === approval.id ? resolvingApproval.decision : null
                return (
                  <ApprovalCard
                    key={`pending-${approval.id}`}
                    approval={approval}
                    toolName={matchedTool?.toolName ?? null}
                    summaryText="检测到待处理的工具执行审批，请确认后继续当前轮次。"
                    createdAt={approval.expiresAt}
                    disabledService={disabledService}
                    resolvingDecision={resolvingDecision}
                    errorMessage={approvalErrors[approval.id]}
                    onResolve={onResolveApproval}
                  />
                )
              })}
            </div>

            {loadOlderError ? (
              <Alert
                tone="danger"
                role="alert"
                title="加载后续记录失败"
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={loadingOlderItems}
                    onClick={() => void loadOlderItems()}
                  >
                    重试加载
                  </Button>
                }
              >
                {loadOlderError.message}
              </Alert>
            ) : null}

            {hasOlderItems ? (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="加载后续分页记录"
                  className="rounded-pill"
                  loading={loadingOlderItems}
                  onClick={() => void loadOlderItems()}
                >
                  加载更多后续记录
                </Button>
              </div>
            ) : null}

            {activeTurnMeta && activeTurn ? (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border/60 bg-surface/70 px-3.5 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Spinner size="sm" label="轮次执行中" />
                  <span className={cn('text-ui font-medium', STATUS_TEXT_TONE[activeTurnMeta.tone])}>
                    {activeTurnMeta.label}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                  <ClockIcon className={iconSize.xs} aria-hidden="true" />
                  截止 {formatDateTime(activeTurn.deadlineAt)}
                </span>
              </div>
            ) : null}

            {activeTurn && !turnActive && activeTurn.error ? (
              <Alert
                tone="danger"
                role="alert"
                title={formatAgentErrorCode(activeTurn.error.code)}
              >
                {activeTurn.error.message}
              </Alert>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
