'use client'

import { useId, useState } from 'react'
import {
  ArrowDownIcon,
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
  Dialog,
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
import type { ReferenceImageAttachment } from '../stores/agent-console-store'
import type { ArtifactOpenRequest } from './artifact-pane'

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
  onOpenArtifact?: (request: Omit<ArtifactOpenRequest, 'nonce'>) => void
  onCreateSession: () => void
  creatingSession?: boolean
  onReusePrompt: (prompt: string) => void
  onReuseImage?: (attachment: ReferenceImageAttachment) => void
  messageAttachments?: Record<string, ReferenceImageAttachment[]>
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
  promptText?: string | null
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
  promptText,
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

  if (!isPending) {
    return (
      <article aria-label="工具执行审批" className="w-full py-0.5">
        <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-pill border border-border/60 bg-surface/60 px-3 py-1 text-caption">
          <ShieldWarningIcon
            className={cn(iconSize.xs, 'shrink-0 text-muted-foreground')}
            aria-hidden="true"
          />
          <span className="font-medium text-foreground">
            {toolName ? `审批 · ${toolName}` : '工具执行审批'}
          </span>
          <span className={cn('font-medium', STATUS_TEXT_TONE[statusMeta.tone])}>
            {statusMeta.label}
          </span>
          <span className="text-muted-foreground">{timeMeta}</span>
          {summaryText ? (
            <span className="max-w-72 truncate text-muted-foreground">· {summaryText}</span>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article
      aria-label="工具执行审批"
      className="motion-pop w-full rounded-panel border border-warning-border bg-warning-soft/45 p-4 sm:p-5"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-warning-soft text-warning">
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

      {promptText && promptText !== summaryText ? (
        <div className="mt-2.5 border-l-2 border-border/70 pl-3 text-caption text-muted-foreground">
          <span className="font-medium text-foreground">调用参数：</span>
          <span className="break-words">{promptText}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <Alert tone="danger" role="alert" className="mt-3">
          {errorMessage}
        </Alert>
      ) : null}

      {approval ? (
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

function AssistantMessageCard({
  item,
  onOpenArtifact,
}: {
  item: AgentItemDTO
  onOpenArtifact?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
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
    <article id={`agent-item-${item.id}`} tabIndex={-1} className="motion-reveal group w-full">
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
        {text ? (!expanded && onOpenArtifact && text.length > 500 ? `${text.slice(0, 500)}…` : text) : '（无文本正文）'}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {onOpenArtifact && text ? <Button size="sm" variant="secondary" onClick={onOpenArtifact}>在 Artifact 中查看与评论</Button> : null}
        {onOpenArtifact && text.length > 500 ? <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((previous) => !previous)}>{expanded ? '收起正文' : '展开正文'}</Button> : null}
      </div>
    </article>
  )
}

function ArtifactReferenceCard({
  item,
  onReusePrompt,
  onReuseImage,
}: {
  item: AgentItemDTO
  onReusePrompt: (prompt: string) => void
  onReuseImage?: (attachment: ReferenceImageAttachment) => void
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const preview = extractArtifactPreview(item)
  const candidateUrl = preview.thumbnailUrl || preview.url
  const safeImageUrl = isSafeDisplayUrl(candidateUrl) ? candidateUrl : null
  const imageError = Boolean(safeImageUrl && failedUrl === safeImageUrl)
  const imageLoaded = Boolean(safeImageUrl && loadedUrl === safeImageUrl)
  const captionTitle =
    preview.label && preview.message && !preview.message.includes(preview.label)
      ? `${preview.label} · ${preview.message}`
      : preview.message || (preview.label ? `产物参考 · ${preview.label}` : '生成产物参考')

  function handleReuseAsReference() {
    if (!safeImageUrl || !onReuseImage) return
    onReuseImage({
      id: preview.assetId ? `art-${preview.assetId}` : `art-${item.id}`,
      url: safeImageUrl,
      name: preview.label || preview.prompt?.slice(0, 24) || '会话生成产物',
      mimeType: preview.mimeType ?? undefined,
      width: preview.width ?? undefined,
      height: preview.height ?? undefined,
      source: 'artifact',
      assetId: preview.assetId ?? undefined,
      prompt: preview.prompt ?? undefined,
    })
  }

  return (
    <article
      className={cn(
        'motion-reveal w-full',
        safeImageUrl
          ? 'max-w-md space-y-2'
          : 'space-y-2 rounded-card border border-border/70 bg-surface/75 px-4 py-3',
      )}
    >
      {safeImageUrl && !imageError ? (
        <button
          type="button"
          aria-label={`放大查看产物：${preview.label || preview.prompt || '生成产物'}`}
          onClick={() => setLightboxOpen(true)}
          className="group relative inline-flex max-w-full overflow-hidden rounded-card border border-border/80 bg-tonal text-left shadow-soft transition-[box-shadow,transform] duration-[var(--motion-base)] ease-out hover:-translate-y-0.5 hover:shadow-floating"
        >
          <img
            src={safeImageUrl}
            alt={preview.prompt || preview.label || 'Agent 产物预览'}
            loading="lazy"
            onLoad={() => setLoadedUrl(safeImageUrl)}
            onError={() => setFailedUrl(safeImageUrl)}
            className={cn(
              'block max-h-96 w-auto max-w-full object-contain',
              imageLoaded && 'motion-fade-in-slow',
            )}
          />
        </button>
      ) : safeImageUrl && imageError ? (
        <div className="inline-flex max-w-full items-center gap-2 rounded-card border border-border/70 bg-tonal/60 px-3.5 py-2.5 text-caption text-muted-foreground">
          <ImageIcon className={cn(iconSize.sm, 'shrink-0')} aria-hidden="true" />
          <span>预览图暂不可用</span>
        </div>
      ) : null}

      <div className="space-y-1.5">
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

        {safeImageUrl || preview.prompt ? (
          <div className="-ml-2 flex flex-wrap items-center gap-1">
            {safeImageUrl && onReuseImage ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="作为参考图复用"
                className="rounded-pill px-2.5 text-caption text-muted-foreground hover:text-foreground"
                onClick={handleReuseAsReference}
                icon={<ImageIcon className={iconSize.xs} aria-hidden="true" />}
              >
                作为参考图
              </Button>
            ) : null}
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
            {safeImageUrl ? (
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="rounded-pill px-2.5 text-caption text-muted-foreground hover:text-foreground"
                icon={<ArrowDownIcon className={iconSize.xs} aria-hidden="true" />}
              >
                <a
                  href={preview.downloadUrl || safeImageUrl}
                  download={`musecanvas-${preview.assetId || item.id}.svg`}
                  aria-label="下载产物图片"
                >
                  下载
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}

        {preview.prompt ? (
          <p className="break-words text-caption leading-relaxed text-muted-foreground">
            提示词：{preview.prompt}
          </p>
        ) : null}
      </div>

      <Dialog
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        title={preview.label || '生成产物预览'}
        description={
          preview.width && preview.height
            ? `分辨率 ${preview.width} × ${preview.height}`
            : undefined
        }
        size="wide"
        footer={
          <>
            {safeImageUrl && onReuseImage ? (
              <Button
                variant="secondary"
                icon={<ImageIcon aria-hidden="true" />}
                onClick={() => {
                  handleReuseAsReference()
                  setLightboxOpen(false)
                }}
              >
                作为参考图
              </Button>
            ) : null}
            {preview.prompt ? (
              <Button
                variant="secondary"
                icon={<MagicWandIcon aria-hidden="true" />}
                onClick={() => {
                  onReusePrompt(preview.prompt!)
                  setLightboxOpen(false)
                }}
              >
                复用提示词
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setLightboxOpen(false)}>
              关闭
            </Button>
          </>
        }
      >
        {safeImageUrl ? (
          <div className="space-y-4">
            <div className="flex justify-center overflow-hidden">
              <img
                src={safeImageUrl}
                alt={preview.prompt || preview.label || '产物大图'}
                className="max-h-[65dvh] w-auto max-w-full rounded-control object-contain"
              />
            </div>
            {preview.prompt ? (
              <p className="border-t border-border/60 pt-3 text-ui leading-relaxed text-muted-foreground">
                {preview.prompt}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
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
    <article className="w-full py-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={payloadId}
        onClick={() => setExpanded((prev) => !prev)}
        className="motion-press inline-flex max-w-full items-center gap-2 rounded-pill border border-border/60 bg-surface/70 px-3 py-1 text-left text-caption hover:border-border hover:bg-surface"
      >
        <Icon className={cn(iconSize.xs, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{toolName}</span>
        {!expanded && detailText ? (
          <span className="max-w-64 truncate text-muted-foreground">{detailText}</span>
        ) : null}
        <span className={cn('shrink-0 font-medium', STATUS_TEXT_TONE[statusMeta.tone])}>
          {statusMeta.label}
        </span>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">
          {formatRelativeTime(item.createdAt)}
        </span>
        <CaretDownIcon
          className={cn(
            iconSize.xs,
            'shrink-0 text-muted-foreground transition-transform duration-[var(--motion-spring-snappy)] ease-spring-snappy motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      <div
        id={payloadId}
        className="motion-accordion"
        data-open={expanded ? 'true' : 'false'}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="motion-accordion-inner">
          <div className="ml-3 mt-1.5 max-w-xl space-y-2 border-l-2 border-border/60 py-1 pl-3.5">
            {detailText ? (
              <p className="break-words text-caption leading-relaxed text-muted-foreground">
                {detailText}
              </p>
            ) : null}
            {payloadInfo.prompt || payloadInfo.size ? (
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-caption sm:grid-cols-2">
                {payloadInfo.prompt ? (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">创作提示词</dt>
                    <dd className="mt-0.5 break-words text-foreground">{payloadInfo.prompt}</dd>
                  </div>
                ) : null}
                {payloadInfo.size ? (
                  <div>
                    <dt className="text-muted-foreground">画幅参数</dt>
                    <dd className="mt-0.5 font-mono text-foreground">{payloadInfo.size}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {!detailText && !payloadInfo.prompt && !payloadInfo.size ? (
              <p className="text-caption text-muted-foreground">已记录调用，无附加参数明细。</p>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  )
}

/**
 * 中央执行时间线：按 sequence 升序展示会话项、工具调用与内联审批，
 * 并负责 404/503 服务边界横幅及活跃轮次进度指示。
 */
export function ExecutionTimeline({
  console: agentConsole,
  onCreateSession,
  creatingSession = false,
  onReusePrompt,
  onReuseImage,
  messageAttachments,
  onResolveApproval,
  resolvingApproval,
  approvalErrors,
  onOpenArtifact,
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

  const hasAlerts =
    serviceStatus === 'disabled_404' ||
    serviceStatus === 'admission_closed_503' ||
    (serviceStatus === 'error' && Boolean(error)) ||
    Boolean(timeline.resyncRequired)

  if (
    sessionId &&
    !snapshotQuery.isPending &&
    !hasAlerts &&
    !hasOlderItems &&
    items.length === 0 &&
    !turnActive &&
    unrenderedPendingApprovals.length === 0
  ) {
    return null
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-20 pb-6 sm:px-6 sm:pt-16 lg:px-10 md:[scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl">
        {serviceStatus === 'disabled_404' ? (
          <Alert tone="warning" title="Agent Core 服务未启用（404）" className="motion-fade-in">
            当前后端配置关闭了 Agent Core V1（<code>AGENT_CORE_ENABLED=false</code>），控制台无法创建会话或发起执行。
          </Alert>
        ) : null}

        {serviceStatus === 'admission_closed_503' ? (
          <Alert
            tone="warning"
            title="Agent 服务暂不可用（503）"
            className="motion-fade-in"
            action={
              <Button size="sm" variant="secondary" onClick={reconnect}>
                重新检查
              </Button>
            }
          >
            服务暂时不可用或相关配置尚未就绪，请稍后重试；如持续出现，请联系管理员检查 Agent Core 与异步执行通道配置。
          </Alert>
        ) : null}

        {serviceStatus === 'error' && error ? (
          <Alert
            tone="danger"
            role="alert"
            title="控制台同步异常"
            className="motion-fade-in"
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
          <Alert tone="info" title="事件流重同步中" className="motion-fade-in">
            检测到事件流滞后（{timeline.resyncRequired}），正在拉取最新会话快照。
          </Alert>
        ) : null}

        {!sessionId ? (
          <div className="motion-fade-in rounded-panel border border-border/70 bg-surface/70 p-8">
            <EmptyState
              icon={SparkleIcon}
              title="选择或新建 Agent 会话"
              description={
                disabledService
                  ? 'Agent Core V1 尚未在服务端启用，请等待管理员配置开启后再试。'
                  : '从左侧列表选择一个已有对话，或直接点击新建开启新对话。'
              }
              action={
                !disabledService ? (
                  <Button
                    variant="primary"
                    className="rounded-pill"
                    loading={creatingSession}
                    disabled={creatingSession}
                    onClick={onCreateSession}
                    icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    新建对话
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
            <div className="flex flex-col gap-5" role="log" aria-label="Agent 执行时间线">
              {items.map((item) => {
                if (item.type === 'user_message') {
                  const messageText = extractItemText(item)
                  const attached =
                    sessionId && messageAttachments
                      ? (messageAttachments[`${sessionId}:${messageText.trim()}`] ?? [])
                      : []
                  return (
                    <article
                      key={item.id}
                      className="motion-reveal ml-auto max-w-[82%] space-y-2 rounded-panel rounded-br-control bg-tonal px-4 py-2.5 text-compact leading-relaxed text-foreground sm:max-w-[75%]"
                    >
                      {attached.length > 0 ? (
                        <div className="flex flex-wrap gap-2 pb-1">
                          {attached.map((att) => (
                            <div
                              key={att.id}
                              className="flex items-center gap-2 rounded-control bg-canvas/70 p-1 pr-2.5"
                            >
                              <img
                                src={att.url}
                                alt={att.name}
                                className="size-11 shrink-0 rounded-control object-cover"
                              />
                              <div className="min-w-0">
                                <p className="max-w-32 truncate text-caption font-medium text-foreground">
                                  {att.name}
                                </p>
                                <p className="text-caption text-muted-foreground">参考图</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <p className="whitespace-pre-wrap break-words">
                        {messageText}
                      </p>
                      <p className="mt-1 text-right text-caption text-muted-foreground">
                        {formatRelativeTime(item.createdAt)}
                      </p>
                    </article>
                  )
                }

                if (item.type === 'assistant_message') {
                  return (
                    <AssistantMessageCard
                      key={item.id}
                      item={item}
                      onOpenArtifact={agentConsole.mode === 'live' && onOpenArtifact ? () => onOpenArtifact({ artifactId: `text:${item.id}` }) : undefined}
                    />
                  )
                }

                if (item.type === 'tool_call' || item.type === 'tool_result') {
                  const matchedTool = item.toolCallId
                    ? timeline.tools[item.toolCallId]
                    : undefined
                  return (
                    <div key={item.id} id={`agent-item-${item.id}`} tabIndex={-1} className="space-y-1">
                      <ToolTraceCard item={item} toolSummary={matchedTool} />
                      {item.type === 'tool_result' && agentConsole.mode === 'live' && onOpenArtifact ? <Button size="sm" variant="ghost" onClick={() => onOpenArtifact({ sourceItemId: item.id })}>查看关联 Artifact 与评论</Button> : null}
                    </div>
                  )
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
                      promptText={payloadInfo.prompt}
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
                      onReuseImage={onReuseImage}
                    />
                  )
                }

                // system_event
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 py-1"
                  >
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
                className="motion-fade-in"
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
                className="motion-fade-in flex flex-wrap items-center justify-between gap-2 rounded-card border border-border/60 bg-surface/70 px-3.5 py-2.5"
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
