'use client'

import { Fragment } from 'react'
import { CoinsIcon } from '@phosphor-icons/react'
import type { CanvasAgentPendingJobDto } from '@musecanvas/contracts'
import { Alert, Badge, Button, iconSize } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { canConfirmPending, pendingStatusLabel } from '../lib/agent-turn-state'
import { confirmationFor } from '../lib/agent-confirmation'
import type { PendingConfirmation } from '../lib/agent-confirmation'
import type { BadgeTone } from '@/shared/components/ui'

const STATUS_TONE: Record<CanvasAgentPendingJobDto['status'], BadgeTone> = {
  pending: 'warning',
  submitting: 'info',
  submitted: 'success',
  rejected: 'neutral',
  expired: 'danger',
}

/** Parameter keys the card shows in its own rows (count and ratio), so they are not repeated. */
const OWN_ROW_KEYS = new Set(['count', 'aspectRatio', 'aspect_ratio', 'ratio'])

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function aspectRatioOf(pending: CanvasAgentPendingJobDto): string | null {
  const value = pending.parameters?.aspectRatio ?? pending.parameters?.aspect_ratio ?? pending.parameters?.ratio
  return typeof value === 'string' && value ? value : null
}

export interface PendingGenerationCardProps {
  pending: CanvasAgentPendingJobDto
  /** Display name of the proposed model; the raw `modelId` is shown when the caller has none. */
  modelName?: string
  /** Injectable clock so expiry is computed at render time, not module load. */
  now: number
  /**
   * Latest confirm/reject lifecycle for this pending (in-flight, submitted,
   * rejected, conflict, expired). Defaults to an idle confirmation.
   */
  confirmation?: PendingConfirmation
  onConfirm: (pending: CanvasAgentPendingJobDto) => void
  onReject: (pending: CanvasAgentPendingJobDto) => void
  /** Offer a fresh request for a stale proposal; never a retry of this pending. */
  onRequestNewProposal?: (pending: CanvasAgentPendingJobDto) => void
}

/**
 * Immutable confirmation card for a proposed generation. Every value shown comes
 * from the persisted DTO (actual mode/model/parameters/inputs/source/selection),
 * and the card has no editable controls: changing the model or parameters requires
 * a *new* proposal, never a PATCH of this pending row.
 *
 * Confirm is the primary action. "修改" backfills the composer with this request so
 * a new proposal can be authored; "拒绝" stays available as a quiet secondary action.
 * A conflict/expiry replaces them with a new-proposal affordance so a stale pending
 * can never be silently re-submitted.
 */
export function PendingGenerationCard({
  pending,
  modelName,
  now,
  confirmation = confirmationFor({}, pending.id),
  onConfirm,
  onReject,
  onRequestNewProposal,
}: PendingGenerationCardProps) {
  const busy = confirmation.phase === 'submitting'
  const invalid = confirmation.requiresNewProposal && confirmation.phase !== 'idle'
  const actionable = canConfirmPending(pending, now) && !busy && !invalid
  const unit = pending.kind === 'video' ? '条' : '张'
  const kindLabel = pending.kind === 'video' ? '视频' : '图像'
  const count = typeof pending.parameters?.count === 'number' ? pending.parameters.count : 1
  const countLabel = count === 1 ? `单${unit}` : `${count} ${unit}`
  const aspectRatio = aspectRatioOf(pending)
  const parameterEntries = Object.entries(pending.parameters ?? {}).filter(([key]) => !OWN_ROW_KEYS.has(key))
  const modelLabel = modelName ?? pending.modelId

  return (
    <article aria-label="待确认的生成提案" className="flex max-w-[620px] flex-col gap-3 rounded-card bg-surface p-4 shadow-soft">
      <header className="flex flex-wrap items-center gap-2">
        {invalid ? <Badge tone="danger">已失效</Badge> : <Badge tone={STATUS_TONE[pending.status]}>{pendingStatusLabel(pending.status)}</Badge>}
        <h3 className="text-sm font-medium text-foreground">{kindLabel} · {countLabel}</h3>
        {pending.status === 'pending' && !invalid ? <span className="text-caption text-muted-foreground">有效至 {new Date(pending.expiresAt).toLocaleString()}</span> : null}
      </header>

      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted-foreground">提示词</dt>
        <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{pending.prompt}</dd>
        <dt className="text-muted-foreground">模型</dt>
        <dd className="truncate font-mono text-foreground" title={pending.modelId}>{modelLabel}</dd>
        <dt className="text-muted-foreground">画幅</dt>
        <dd className="font-mono tabular-nums text-foreground">{[aspectRatio, `${count} ${unit}`].filter(Boolean).join(' · ')}</dd>
        {pending.sourceAssetId ? (
          <>
            <dt className="text-muted-foreground">源素材</dt>
            <dd className="truncate font-mono text-foreground" title={pending.sourceAssetId}>{pending.sourceAssetId}</dd>
          </>
        ) : null}
        {pending.editMetadata ? (
          <>
            <dt className="text-muted-foreground">选区</dt>
            <dd className="font-mono tabular-nums text-foreground">{pending.editMetadata.selection.width}×{pending.editMetadata.selection.height} @ ({pending.editMetadata.selection.x}, {pending.editMetadata.selection.y}) · 源图 {pending.editMetadata.sourceWidth}×{pending.editMetadata.sourceHeight}</dd>
          </>
        ) : null}
        {pending.normalizedInputs?.length ? (
          <>
            <dt className="text-muted-foreground">输入</dt>
            <dd className="text-foreground">{pending.normalizedInputs.map((item) => `${item.role}#${item.position}`).join('、')}</dd>
          </>
        ) : null}
        {parameterEntries.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="truncate text-foreground" title={scalar(value)}>{scalar(value)}</dd>
          </Fragment>
        ))}
      </dl>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CoinsIcon weight="bold" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
        确认后将调用第三方模型，可能产生实际调用费用。修改模型或参数需要发送新的提案，已记录的提案不可修改。
      </p>

      {pending.jobId ? (
        <p className="text-xs text-muted-foreground">已生成任务 <span className="font-mono">{pending.jobId}</span>，结果可在下方查看。</p>
      ) : null}

      {confirmation.message ? (
        <Alert
          tone={invalid ? 'danger' : 'info'}
          role={invalid ? 'alert' : 'status'}
        >
          {confirmation.message}
        </Alert>
      ) : null}

      {invalid ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">该提案已无法确认；请发送新的请求生成新提案。</p>
          {onRequestNewProposal ? (
            <Button variant="secondary" size="sm" onClick={() => onRequestNewProposal(pending)}>发送新的请求</Button>
          ) : null}
        </div>
      ) : pending.status === 'pending' || pending.status === 'submitting' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!actionable}
            loading={busy || pending.status === 'submitting'}
            onClick={() => onConfirm(pending)}
          >
            确认并生成
          </Button>
          {onRequestNewProposal ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRequestNewProposal(pending)}>修改</Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={!actionable} className="text-muted-foreground" onClick={() => onReject(pending)}>拒绝</Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">该提案已结束（{pendingStatusLabel(pending.status)}），如需生成请发送新的请求。</p>
      )}
    </article>
  )
}
