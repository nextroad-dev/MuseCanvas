'use client'

import { useEffect, useRef, useState } from 'react'
import { CaretRightIcon as ChevronRight, ArrowClockwiseIcon as RefreshCw, XCircleIcon as XCircle } from '@phosphor-icons/react'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { MediaFrame } from '@/shared/components/media-frame'
import { Alert, Button, Progress, Skeleton, SkeletonRow, SkeletonTile } from '@/shared/components/ui'
import { formatElapsed, isJobActive, phaseLabel } from '@/shared/lib/job-status'
import { cn } from '@/shared/lib/cn'
import { isVideoOutput, outputUrl } from '@/shared/types'
import type { GenerationJob } from '@/shared/types'

const LINGER_MS = 6000
const FADE_MS = 500
const TICK_MS = 500

export interface ActiveJobsBoardProps {
  jobs: GenerationJob[]
  isLoading: boolean
  isError: boolean
  onReload: () => void
  selectedJobId: string | null
  onSelectJob: (jobId: string) => void
  onCancel: (jobId: string) => void
  onRetry: (jobId: string) => void
  pendingCancelId?: string | null
  pendingRetryId?: string | null
  disabled?: boolean
  actionErrors?: Record<string, string>
  /** `rail` collapses; `inline` stays open in the task dialog. */
  variant?: 'rail' | 'inline'
  /** The mobile copy would otherwise park an empty card under the prompt box. */
  hideWhenEmpty?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
}

export function ActiveJobsBoard({
  jobs,
  isLoading,
  isError,
  onReload,
  selectedJobId,
  onSelectJob,
  onCancel,
  onRetry,
  pendingCancelId,
  pendingRetryId,
  disabled = false,
  actionErrors = {},
  variant = 'rail',
  hideWhenEmpty = false,
  open = true,
  onToggle,
}: ActiveJobsBoardProps) {
  const [now, setNow] = useState(() => Date.now())
  const [lingering, setLingering] = useState<Record<string, number>>({})
  const [announcement, setAnnouncement] = useState('')
  const previousActiveIds = useRef<Set<string> | null>(null)
  const headingRef = useRef<HTMLButtonElement>(null)
  const latestJobs = useRef(jobs)
  latestJobs.current = jobs

  const activeJobs = jobs.filter(isJobActive)
  const activeSignature = activeJobs.map((job) => job.id).join(',')
  const lingeringIds = Object.keys(lingering)
  const isRail = variant === 'rail'
  const listId = `${variant}-active-jobs-list`
  const headingId = `${variant}-active-jobs-heading`
  const count = activeJobs.length

  const alive = count > 0 || lingeringIds.length > 0

  useEffect(() => {
    if (!alive) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [alive])

  useEffect(() => {
    const ids = new Set(activeSignature ? activeSignature.split(',') : [])
    const finished = previousActiveIds.current
      ? [...previousActiveIds.current].filter((id) => !ids.has(id))
      : []

    if (finished.length > 0) {
      const expireAt = Date.now() + LINGER_MS
      setLingering((current) => {
        const next = { ...current }
        for (const id of finished) next[id] = expireAt
        return next
      })
      if (ids.size === 0) {
        const settled = latestJobs.current.find((job) => job.id === finished[0])
        const outcome =
          settled?.status === 'succeeded'
            ? '已完成'
            : settled?.status === 'failed'
              ? '生成失败'
              : '已结束'
        setAnnouncement(
          finished.length === 1 && settled
            ? `任务${outcome}：${settled.prompt.slice(0, 16)}，详情见历史记录`
            : `有 ${finished.length} 个任务已结束，详情见历史记录`,
        )
      }
    }
    previousActiveIds.current = ids
  }, [activeSignature])

  useEffect(() => {
    const expired = lingeringIds.filter((id) => lingering[id] <= now)
    if (expired.length === 0) return
    const holdsFocus = expired.some((id) => document.querySelector(`[data-job-row="${id}"]:focus-within`))
    setLingering((current) => {
      const next = { ...current }
      for (const id of expired) delete next[id]
      return next
    })
    if (holdsFocus) headingRef.current?.focus()
  }, [now, lingering])

  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const finishedRows = lingeringIds
    .map((id) => jobsById.get(id))
    .filter((job): job is GenerationJob => Boolean(job) && !isJobActive(job!))
  const rows = [...activeJobs, ...finishedRows]

  if (hideWhenEmpty && rows.length === 0 && !isLoading && !isError) return null

  const heading = isRail ? (
    <h2 id={headingId} className="shrink-0 text-sm">
      <Button
        ref={headingRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => onToggle?.(!open)}
        className="w-full justify-start px-2 text-left"
        icon={<ChevronRight weight="bold" aria-hidden="true" className={cn('motion-position', open && 'rotate-90')} />}
      >
        <span>进行中</span>
        {count > 0 && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
      </Button>
    </h2>
  ) : (
    <h2 id={headingId} className="flex shrink-0 items-center gap-2 text-sm text-foreground">
      进行中
      {count > 0 && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </h2>
  )

  const body = (
    <>
      {isError ? (
        <Alert
          tone="danger"
          title="无法读取任务列表"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={onReload}
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
            >
              重试
            </Button>
          }
        >
          列表刷新失败，请稍后重试。
        </Alert>
      ) : null}
      {rows.length === 0 && !open ? null : rows.length === 0 ? (
        isLoading ? (
          <div aria-busy="true">
            <span className="sr-only">加载任务中</span>
            <ul id={listId} role="list" className="m-0 flex list-none flex-col gap-1 overflow-hidden p-0">
              {Array.from({ length: 2 }, (_, index) => (
                <li key={index} aria-hidden="true" className="flex gap-3 rounded-control bg-tonal p-3">
                  <SkeletonTile className="h-12 w-12 shrink-0 basis-auto rounded-control" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <SkeletonRow cells={2} cellWidth="96px" className="min-h-4" />
                    <Skeleton className="h-1 w-full rounded-pill" />
                    <SkeletonRow />
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-3 flex-1" />
                      <Skeleton className="h-[var(--control-sm)] w-14" />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">当前没有进行中的任务</p>
        )
      ) : (
        <ul
          id={listId}
          role="list"
          className={cn(
            'm-0 list-none flex flex-col gap-1 overflow-y-auto p-0',
            !open && 'hidden',
            isRail && 'max-h-64',
          )}
        >
          {rows.map((job) => (
            <ActiveJobRow
              key={job.id}
              job={job}
              now={now}
              expiringAt={lingering[job.id]}
              selected={job.id === selectedJobId}
              onSelectJob={onSelectJob}
              onCancel={onCancel}
              onRetry={onRetry}
              pendingCancelId={pendingCancelId}
              pendingRetryId={pendingRetryId}
              disabled={disabled}
              actionError={actionErrors[job.id]}
            />
          ))}
        </ul>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  )

  // `rail` is a bare column in the sidebar; `inline` sits in the task dialog as a
  // plain section. Same children, no box on either side: layering comes from the rows.
  return isRail ? (
    <section aria-labelledby={headingId} className="flex min-h-0 shrink-0 flex-col gap-1 px-2 pb-2">
      {heading}
      {body}
    </section>
  ) : (
    <section aria-labelledby={headingId} className="flex min-h-0 shrink-0 flex-col gap-3">
      {heading}
      {body}
    </section>
  )
}

interface ActiveJobRowProps {
  job: GenerationJob
  now: number
  expiringAt?: number
  selected: boolean
  onSelectJob: (jobId: string) => void
  onCancel: (jobId: string) => void
  onRetry: (jobId: string) => void
  pendingCancelId?: string | null
  pendingRetryId?: string | null
  disabled: boolean
  actionError?: string
}

function ActiveJobRow({
  job,
  now,
  expiringAt,
  selected,
  onSelectJob,
  onCancel,
  onRetry,
  pendingCancelId,
  pendingRetryId,
  disabled,
  actionError,
}: ActiveJobRowProps) {
  const active = isJobActive(job)
  const firstOutput = job.outputs?.[0]
  // `progress` is binary in the worker, so the ticking clock is the only liveness
  // signal between 2.5s polls; it stops at `completedAt` once the job settles.
  const clockEnd = job.completedAt ? Date.parse(job.completedAt) : now
  const unit = job.mediaKind === 'video' ? '段' : '张'

  const stage = active
    ? job.status === 'queued'
      ? '已提交，等待服务返回'
      : job.status === 'retry_wait'
        ? '上次未成功，等待重试'
        : phaseLabel(job.phase)
    : job.status === 'succeeded'
      ? `${job.outputs?.length ?? 0} ${unit}产物`
      : ''

  // Historical parameters are rendered straight from the stored request, with no
  // lookup against the model's *current* descriptors. A job created before a
  // contract was tightened still has to show what it was actually generated
  // with, even where no control on offer today could produce that value again.
  const historicalParameters = Object.entries(job.parameters ?? {})
    .filter(([name, value]) => value !== undefined && value !== null && name !== 'size' && name !== 'count')
    .map(([name, value]) => `${name}=${String(value)}`)

  const meta = [
    job.modelName,
    job.size,
    Number.isFinite(job.count) ? `${job.count} ${unit}` : null,
    ...historicalParameters,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li
      data-job-row={job.id}
      className={cn(
        'relative flex gap-3 rounded-control p-3',
        // The row leaves the list on a token exit, not a hand-set opacity: same
        // 160ms ease-in every other departing surface uses.
        expiringAt !== undefined && expiringAt - now <= FADE_MS && 'motion-fade-out',
        selected ? 'bg-tonal-selected' : active ? 'bg-tonal' : 'bg-neutral-soft',
      )}
    >
      {firstOutput && (
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-control bg-tonal">
          <MediaFrame
            src={outputUrl(firstOutput)}
            kind={firstOutput.mediaKind}
            alt=""
            layout="thumb"
            durationSeconds={
              isVideoOutput(firstOutput) ? firstOutput.metadata.durationSeconds : undefined
            }
            hasAudio={isVideoOutput(firstOutput) ? firstOutput.metadata.hasAudio : undefined}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <JobStatusBadge status={job.status} busy={active} />
          {stage ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{stage}</span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatElapsed(job, clockEnd)}
          </span>
        </div>

        {active && (
          // The worker writes `progress` as 0 or 100, so there is no real percentage
          // to claim: the indeterminate track says "working" without inventing a
          // number, and the ticking clock above carries the liveness.
          <Progress value={null} label={stage || '生成中'} showLabelRow={false} />
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelectJob(job.id)}
          disabled={disabled}
          aria-current={selected ? 'true' : undefined}
          className="w-full justify-start whitespace-normal px-2 text-left"
        >
          <span className="line-clamp-2 leading-[1.5]">{job.prompt}</span>
        </Button>

        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</p>

          {active && (
            <Button
              type="button"
              variant="danger-ghost"
              size="sm"
              onClick={() => onCancel(job.id)}
              disabled={disabled || Boolean(job.cancelRequested) || Boolean(pendingCancelId)}
              loading={pendingCancelId === job.id}
              aria-label={`取消任务：${job.prompt.slice(0, 20)}`}
              className="px-2 text-xs"
              icon={<XCircle weight="bold" aria-hidden="true" />}
            >
              {job.cancelRequested ? '取消中' : '取消'}
            </Button>
          )}

          {job.status === 'failed' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onRetry(job.id)}
              loading={pendingRetryId === job.id}
              disabled={disabled || Boolean(pendingRetryId)}
              aria-label={`重试任务：${job.prompt.slice(0, 20)}`}
              className="px-2 text-xs"
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
            >
              重试
            </Button>
          )}
        </div>

        {actionError && <p role="alert" className="text-xs text-danger">{actionError}</p>}
        {job.status === 'failed' && job.errorMessage && (
          <p className="line-clamp-1 text-xs text-danger">{job.errorMessage}</p>
        )}
      </div>
    </li>
  )
}
