'use client'

import Link from 'next/link'
import {
  CheckCircleIcon,
  ListChecksIcon,
  ShieldWarningIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { AgentApprovalSummaryDTO } from '@musecanvas/contracts'
import {
  Alert,
  Button,
  SkeletonRow,
  iconSize,
  type BadgeTone,
} from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { ArtifactPane, type ArtifactDraftCache, type ArtifactOpenRequest } from './artifact-pane'
import { useJobs } from '@/shared/hooks/useJobs'
import { APP_ROUTES, type WorkspaceInspectorTab } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDateTime, formatRelativeTime, truncateText } from '@/shared/lib/format'
import { jobStatusMeta } from '@/shared/lib/job-status'
import {
  extractToolPayloadInfo,
  formatApprovalStatus,
  formatToolStatus,
  formatTurnStatus,
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
  activeTab?: WorkspaceInspectorTab
  onChangeTab?: (tab: WorkspaceInspectorTab) => void
  onReusePrompt: (prompt: string) => void
  onResolveApproval: (
    approval: AgentApprovalSummaryDTO,
    decision: 'approved' | 'rejected',
  ) => Promise<void>
  resolvingApproval: { id: string; decision: 'approved' | 'rejected' } | null
  approvalErrors: Record<string, string>
  onClose?: () => void
  artifactRequest?: ArtifactOpenRequest
  artifactDrafts: ArtifactDraftCache
  onJumpToMessage: (sourceItemId: string) => void
}

/**
 * 右上角悬浮检查器卡片：合并展示当前轮次、待处理审批、会话产物、工具调用记录与最近媒体任务。
 */
export function InspectorPanel({
  console: agentConsole,
  artifactRequest,
  artifactDrafts,
  onJumpToMessage,
  onResolveApproval,
  resolvingApproval,
  approvalErrors,
  onClose,
}: InspectorPanelProps) {
  const jobsQuery = useJobs({ limit: 6 })
  const jobs = jobsQuery.data?.items ?? []

  const disabledService = agentConsole.serviceStatus === 'disabled_404'
  const resolvedApprovals = agentConsole.approvals.filter(
    (approval) => approval.status !== 'pending',
  )

  const displayTools: Array<{ id: string; toolName: string; status: string }> =
    agentConsole.tools.length > 0
      ? agentConsole.tools.map((tool) => ({
          id: tool.id,
          toolName: tool.toolName,
          status: tool.status,
        }))
      : (() => {
          const map = new Map<string, { id: string; toolName: string; status: string }>()
          for (const item of agentConsole.items) {
            if (item.type !== 'tool_call' && item.type !== 'tool_result') continue
            const key = item.toolCallId || item.id
            const info = extractToolPayloadInfo(item)
            const prev = map.get(key)
            if (item.type === 'tool_result' || !prev) {
              map.set(key, {
                id: key,
                toolName:
                  info.toolName ??
                  prev?.toolName ??
                  (item.type === 'tool_result' ? '工具结果' : '工具调用'),
                status: info.status ?? (item.type === 'tool_result' ? 'completed' : 'recorded'),
              })
            }
          }
          return Array.from(map.values())
        })()

  const pendingApprovalIdSet = new Set(agentConsole.pendingApprovals.map((a) => a.id))
  const pendingApprovalToolIdSet = new Set(
    agentConsole.pendingApprovals.map((a) => a.toolCallId),
  )

  const displayResolvedApprovals: Array<{
    id: string
    toolName: string
    statusLabel: string
    tone: BadgeTone
    timeText: string
  }> =
    resolvedApprovals.length > 0
      ? resolvedApprovals.map((approval) => {
          const meta = formatApprovalStatus(approval.status)
          const tool = agentConsole.timeline.tools[approval.toolCallId]
          return {
            id: approval.id,
            toolName: tool?.toolName ?? '工具调用审批',
            statusLabel: meta.label,
            tone: meta.tone,
            timeText: approval.resolvedAt
              ? formatDateTime(approval.resolvedAt)
              : formatDateTime(approval.expiresAt),
          }
        })
      : agentConsole.items
          .filter((item) => item.type === 'approval')
          .filter((item) => {
            const info = extractToolPayloadInfo(item)
            if (info.approvalId && pendingApprovalIdSet.has(info.approvalId)) return false
            if (item.toolCallId && pendingApprovalToolIdSet.has(item.toolCallId)) return false
            return true
          })
          .map((item) => {
            const info = extractToolPayloadInfo(item)
            return {
              id: item.id,
              toolName: info.toolName ?? '工具调用审批',
              statusLabel: '已审批',
              tone: 'success' as BadgeTone,
              timeText: formatDateTime(item.createdAt),
            }
          })

  const activeTurnMeta =
    agentConsole.turnActive && agentConsole.activeTurn
      ? formatTurnStatus(agentConsole.activeTurn.status, {
          cancelRequestedAt: agentConsole.activeTurn.cancelRequestedAt,
          errorCode: agentConsole.activeTurn.error?.code,
        })
      : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ListChecksIcon className={cn(iconSize.sm, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
          <h2 className="truncate text-ui font-medium text-foreground">工作区检查器</h2>
          {agentConsole.pendingApprovals.length > 0 ? (
            <span className="inline-flex items-center rounded-pill bg-warning-soft px-2 py-0.5 text-caption font-medium text-warning">
              {agentConsole.pendingApprovals.length} 待审批
            </span>
          ) : null}
        </div>
        {onClose ? (
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 rounded-pill sm:size-8"
            aria-label="收起检查器"
            title="收起检查器"
            onClick={onClose}
            icon={<XIcon className={iconSize.sm} aria-hidden="true" />}
          />
        ) : null}
      </div>

      <div
        aria-label="工作区检查器内容"
        className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto px-4 py-2"
      >
        {activeTurnMeta && agentConsole.activeTurn ? (
          <section aria-label="当前轮次状态" className="py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui font-medium leading-snug text-foreground">当前轮次</span>
              <span className={cn('text-caption font-medium', STATUS_TEXT_TONE[activeTurnMeta.tone])}>
                {activeTurnMeta.label}
              </span>
            </div>
            <p className="mt-1 text-caption leading-snug text-muted-foreground">
              截止 {formatDateTime(agentConsole.activeTurn.deadlineAt)}
            </p>
          </section>
        ) : null}

        {agentConsole.pendingApprovals.length > 0 ? (
          <section aria-label="待处理审批" className="space-y-2.5 py-2.5">
            <h3 className="text-caption font-medium text-warning">
              待处理审批 ({agentConsole.pendingApprovals.length})
            </h3>
            <ul className="divide-y divide-border/40" role="list">
              {agentConsole.pendingApprovals.map((approval) => {
                const tool = agentConsole.timeline.tools[approval.toolCallId]
                const busy = resolvingApproval !== null
                const resolvingThis = resolvingApproval?.id === approval.id
                return (
                  <li
                    key={approval.id}
                    className="space-y-2 py-2.5 first:pt-0 last:pb-0"
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
          </section>
        ) : null}

        <section aria-label="会话 Artifact 与私密讨论" className="space-y-2.5 py-2.5">
          <ArtifactPane
            key={`${agentConsole.mode}:${agentConsole.actorId}:${agentConsole.sessionId ?? ''}`}
            console={agentConsole}
            request={artifactRequest}
            drafts={artifactDrafts}
            onJumpToMessage={onJumpToMessage}
          />
        </section>

        <section aria-label="工具调用与审批记录" className="space-y-2.5 py-2.5">
          <div className="flex items-center gap-1.5">
            <WrenchIcon className={cn(iconSize.xs, 'text-muted-foreground')} aria-hidden="true" />
            <h3 className="text-caption font-medium text-muted-foreground">
              工具与审批记录 ({displayTools.length + displayResolvedApprovals.length})
            </h3>
          </div>
          {displayTools.length === 0 && displayResolvedApprovals.length === 0 ? (
            <p className="py-1 text-caption text-muted-foreground">
              当前暂无工具调用或已处理审批记录。
            </p>
          ) : (
            <ul className="divide-y divide-border/40" role="list">
              {displayTools.map((tool) => {
                const meta = formatToolStatus(tool.status)
                return (
                  <li
                    key={`tool-${tool.id}`}
                    className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
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
              {displayResolvedApprovals.map((approval) => (
                <li
                  key={`approval-${approval.id}`}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-ui font-medium leading-snug text-foreground">
                      {approval.toolName}
                    </span>
                    <span className={cn('shrink-0 text-caption font-medium', STATUS_TEXT_TONE[approval.tone])}>
                      {approval.statusLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
                    {approval.timeText}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="工作区最近媒体任务" className="space-y-2.5 py-2.5">
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
            <p className="py-1 text-caption text-muted-foreground">
              暂无最近的媒体生成任务。
            </p>
          ) : (
            <ul className="divide-y divide-border/40" role="list">
              {jobs.map((job) => {
                const meta = jobStatusMeta(job.status)
                return (
                  <li
                    key={job.id}
                    className="py-2 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('text-caption font-medium', STATUS_TEXT_TONE[meta.tone])}>
                        {meta.label}
                      </span>
                      <span className="text-caption text-muted-foreground">
                        {formatRelativeTime(job.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 break-words text-caption leading-snug text-foreground">
                      {truncateText(job.inputPrompt || job.prompt, 72) || '未命名任务'}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
