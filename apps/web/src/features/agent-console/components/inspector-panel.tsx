'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ImageIcon,
  ListChecksIcon,
  MagicWandIcon,
  ShieldWarningIcon,
  WrenchIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import type { AgentApprovalSummaryDTO } from '@musecanvas/contracts'
import {
  Alert,
  Button,
  SkeletonRow,
  Tabs,
  iconSize,
  type BadgeTone,
} from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { useJobs } from '@/shared/hooks/useJobs'
import { APP_ROUTES, type WorkspaceInspectorTab } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDateTime, formatRelativeTime, truncateText } from '@/shared/lib/format'
import { jobStatusMeta } from '@/shared/lib/job-status'
import {
  extractArtifactPreview,
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

export interface InspectorPanelProps {
  console: AgentConsoleController
  activeTab: WorkspaceInspectorTab
  onChangeTab: (tab: WorkspaceInspectorTab) => void
  onReusePrompt: (prompt: string) => void
  onResolveApproval: (
    approval: AgentApprovalSummaryDTO,
    decision: 'approved' | 'rejected',
  ) => Promise<void>
  resolvingApproval: { id: string; decision: 'approved' | 'rejected' } | null
  approvalErrors: Record<string, string>
}

function ArtifactThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="flex size-16 shrink-0 items-center justify-center rounded-control border border-border/70 bg-tonal text-muted-foreground">
        <ImageIcon className={iconSize.md} aria-hidden="true" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-16 shrink-0 rounded-control border border-border/70 bg-tonal object-cover"
    />
  )
}

/**
 * 右侧可折叠检查器面板：当前轮次与作品任务产物、工具调用记录与审批队列。
 */
export function InspectorPanel({
  console: agentConsole,
  activeTab,
  onChangeTab,
  onReusePrompt,
  onResolveApproval,
  resolvingApproval,
  approvalErrors,
}: InspectorPanelProps) {
  const jobsQuery = useJobs({ limit: 8 })
  const jobs = jobsQuery.data?.items ?? []

  const artifactItems = agentConsole.items.filter((item) => item.type === 'artifact_reference')
  const disabledService = agentConsole.serviceStatus === 'disabled_404'
  const resolvedApprovals = agentConsole.approvals.filter(
    (approval) => approval.status !== 'pending',
  )
  const activeTurnMeta =
    agentConsole.turnActive && agentConsole.activeTurn
      ? formatTurnStatus(agentConsole.activeTurn.status, {
          cancelRequestedAt: agentConsole.activeTurn.cancelRequestedAt,
          errorCode: agentConsole.activeTurn.error?.code,
        })
      : null

  const normalizedTab: WorkspaceInspectorTab = activeTab === 'tools' ? 'tools' : 'artifacts'

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="shrink-0 border-b border-border/70 px-4 pt-2">
        <Tabs
          aria-label="检查器面板标签"
          variant="underline"
          listClassName="border-b-0"
          value={normalizedTab}
          onChange={(id) => onChangeTab(id as WorkspaceInspectorTab)}
          tabs={[
            {
              id: 'artifacts',
              label: '任务与产物',
              icon: <ListChecksIcon className={iconSize.sm} aria-hidden="true" />,
            },
            {
              id: 'tools',
              label:
                agentConsole.pendingApprovals.length > 0
                  ? `工具与审批 (${agentConsole.pendingApprovals.length})`
                  : '工具与审批',
              icon: <WrenchIcon className={iconSize.sm} aria-hidden="true" />,
            },
          ]}
        />
      </div>

      <div
        role="tabpanel"
        aria-label={normalizedTab === 'tools' ? '工具与审批检查器' : '任务与产物检查器'}
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
        {normalizedTab === 'artifacts' ? (
          <div className="space-y-5">
            {activeTurnMeta && agentConsole.activeTurn ? (
              <section aria-label="当前轮次状态" className="space-y-2.5">
                <div className="rounded-card border border-border/70 bg-canvas/50 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ui font-medium leading-snug text-foreground">当前轮次</span>
                    <span className={cn('text-caption font-medium', STATUS_TEXT_TONE[activeTurnMeta.tone])}>
                      {activeTurnMeta.label}
                    </span>
                  </div>
                  <p className="mt-1 text-caption leading-snug text-muted-foreground">
                    截止 {formatDateTime(agentConsole.activeTurn.deadlineAt)}
                  </p>
                </div>
              </section>
            ) : null}

            <section aria-label="会话生成产物" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-caption font-medium text-muted-foreground">
                  会话产物 ({artifactItems.length})
                </h3>
                <Link
                  href={APP_ROUTES.library}
                  className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
                >
                  <span>打开作品图库</span>
                  <ArrowSquareOutIcon className={iconSize.xs} aria-hidden="true" />
                </Link>
              </div>

              {artifactItems.length === 0 ? (
                <p className="rounded-card border border-border/70 bg-canvas/50 px-4 py-5 text-center text-caption leading-relaxed text-muted-foreground">
                  当前会话暂无产物引用，批准执行生成工具后将显示在此处。
                </p>
              ) : (
                <ul className="space-y-2.5" role="list">
                  {artifactItems.map((item) => {
                    const preview = extractArtifactPreview(item)
                    const candidateUrl = preview.thumbnailUrl || preview.url
                    const safeUrl = isSafeDisplayUrl(candidateUrl) ? candidateUrl : null
                    return (
                      <li
                        key={item.id}
                        className="flex min-w-0 items-start gap-3 rounded-card border border-border/70 bg-canvas/50 p-3"
                      >
                        {safeUrl ? (
                          <ArtifactThumbnail
                            src={safeUrl}
                            alt={preview.prompt || preview.label || '会话产物'}
                          />
                        ) : (
                          <div className="flex size-16 shrink-0 items-center justify-center rounded-control border border-border/70 bg-tonal text-muted-foreground">
                            <ImageIcon className={iconSize.md} aria-hidden="true" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="truncate text-ui font-medium leading-snug text-foreground">
                            {preview.label || preview.message || '生成产物'}
                          </p>
                          {preview.prompt ? (
                            <p className="line-clamp-2 break-words text-caption leading-snug text-muted-foreground">
                              {preview.prompt}
                            </p>
                          ) : null}
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                            <span className="text-caption text-muted-foreground">
                              {preview.width && preview.height
                                ? `${preview.width}×${preview.height}`
                                : formatRelativeTime(item.createdAt)}
                            </span>
                            {preview.prompt ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="rounded-pill px-2.5 text-caption"
                                onClick={() => onReusePrompt(preview.prompt!)}
                                icon={<MagicWandIcon className={iconSize.xs} aria-hidden="true" />}
                              >
                                复用
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section aria-label="工作区最近媒体任务" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-caption font-medium text-muted-foreground">
                  最近媒体任务 ({jobs.length})
                </h3>
                <Link
                  href={APP_ROUTES.library}
                  className="text-caption font-medium text-accent hover:underline"
                >
                  全部作品
                </Link>
              </div>

              {jobsQuery.isPending ? (
                <div aria-busy="true" className="space-y-2">
                  <SkeletonRow cells={1} />
                  <SkeletonRow cells={1} />
                </div>
              ) : jobs.length === 0 ? (
                <p className="rounded-card border border-border/70 bg-canvas/50 px-4 py-5 text-center text-caption leading-relaxed text-muted-foreground">
                  暂无最近的媒体生成任务。
                </p>
              ) : (
                <ul className="space-y-2" role="list">
                  {jobs.map((job) => {
                    const meta = jobStatusMeta(job.status)
                    return (
                      <li
                        key={job.id}
                        className="rounded-card border border-border/70 bg-canvas/50 px-3.5 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn('text-caption font-medium', STATUS_TEXT_TONE[meta.tone])}>
                            {meta.label}
                          </span>
                          <span className="text-caption text-muted-foreground">
                            {formatRelativeTime(job.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 break-words text-caption leading-snug text-foreground">
                          {truncateText(job.inputPrompt || job.prompt, 72) || '未命名任务'}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <div className="space-y-5">
            <section aria-label="待处理审批" className="space-y-2.5">
              <h3 className="text-caption font-medium text-muted-foreground">
                待处理审批 ({agentConsole.pendingApprovals.length})
              </h3>
              {agentConsole.pendingApprovals.length === 0 ? (
                <p className="rounded-card border border-border/70 bg-canvas/50 px-4 py-5 text-center text-caption leading-relaxed text-muted-foreground">
                  当前没有待确认的审批请求。
                </p>
              ) : (
                <ul className="space-y-2.5" role="list">
                  {agentConsole.pendingApprovals.map((approval) => {
                    const tool = agentConsole.timeline.tools[approval.toolCallId]
                    const busy = resolvingApproval !== null
                    const resolvingThis = resolvingApproval?.id === approval.id
                    return (
                      <li
                        key={approval.id}
                        className="space-y-2.5 rounded-card border border-warning-border bg-warning-soft/45 p-3.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <ShieldWarningIcon
                              className={cn(iconSize.sm, 'shrink-0 text-warning')}
                              aria-hidden="true"
                            />
                            <span className="truncate text-ui font-medium leading-snug text-foreground">
                              {tool?.toolName ?? '工具调用审批'}
                            </span>
                          </div>
                          <span className="shrink-0 text-caption font-medium text-warning">
                            待审批
                          </span>
                        </div>

                        <p className="text-caption leading-snug text-muted-foreground">
                          有效期至 {formatDateTime(approval.expiresAt)}
                        </p>

                        {approvalErrors[approval.id] ? (
                          <Alert tone="danger" role="alert">
                            {approvalErrors[approval.id]}
                          </Alert>
                        ) : null}

                        {!disabledService ? (
                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            <Button
                              size="sm"
                              variant="danger-ghost"
                              className="rounded-pill"
                              disabled={busy}
                              loading={resolvingThis && resolvingApproval?.decision === 'rejected'}
                              onClick={() => void onResolveApproval(approval, 'rejected')}
                              icon={<XCircleIcon className={iconSize.sm} aria-hidden="true" />}
                            >
                              拒绝
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              className="rounded-pill"
                              disabled={busy}
                              loading={resolvingThis && resolvingApproval?.decision === 'approved'}
                              onClick={() => void onResolveApproval(approval, 'approved')}
                              icon={<CheckCircleIcon className={iconSize.sm} aria-hidden="true" />}
                            >
                              批准执行
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {resolvedApprovals.length > 0 ? (
              <section aria-label="历史审批记录" className="space-y-2.5">
                <h3 className="text-caption font-medium text-muted-foreground">
                  已处理审批 ({resolvedApprovals.length})
                </h3>
                <ul className="space-y-2" role="list">
                  {resolvedApprovals.map((approval) => {
                    const meta = formatApprovalStatus(approval.status)
                    const tool = agentConsole.timeline.tools[approval.toolCallId]
                    return (
                      <li
                        key={approval.id}
                        className="rounded-card border border-border/70 bg-canvas/50 px-3.5 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-ui font-medium leading-snug text-foreground">
                            {tool?.toolName ?? '工具调用审批'}
                          </span>
                          <span className={cn('shrink-0 text-caption font-medium', STATUS_TEXT_TONE[meta.tone])}>
                            {meta.label}
                          </span>
                        </div>
                        <p className="mt-1 text-caption leading-snug text-muted-foreground">
                          {approval.resolvedAt
                            ? formatDateTime(approval.resolvedAt)
                            : formatDateTime(approval.expiresAt)}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}

            <section aria-label="工具调用摘要" className="space-y-2.5">
              <h3 className="text-caption font-medium text-muted-foreground">
                工具调用记录 ({agentConsole.tools.length})
              </h3>
              {agentConsole.tools.length === 0 ? (
                <p className="rounded-card border border-border/70 bg-canvas/50 px-4 py-5 text-center text-caption leading-relaxed text-muted-foreground">
                  当前轮次暂无工具调用记录。
                </p>
              ) : (
                <ul className="space-y-2" role="list">
                  {agentConsole.tools.map((tool) => {
                    const meta = formatToolStatus(tool.status)
                    return (
                      <li
                        key={tool.id}
                        className="flex items-center justify-between gap-2 rounded-card border border-border/70 bg-canvas/50 px-3.5 py-2.5"
                      >
                        <span className="truncate text-ui font-medium leading-snug text-foreground">
                          {tool.toolName}
                        </span>
                        <span className={cn('shrink-0 text-caption font-medium', STATUS_TEXT_TONE[meta.tone])}>
                          {meta.label}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
