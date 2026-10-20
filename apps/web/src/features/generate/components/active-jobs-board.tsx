'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowClockwiseIcon as RefreshCw, XCircleIcon as XCircle } from '@phosphor-icons/react'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { MediaFrame } from '@/shared/components/media-frame'
import { Alert, Button, Progress, Skeleton, SkeletonRow, SkeletonTile } from '@/shared/components/ui'
import { formatElapsed, isJobActive, phaseLabel } from '@/shared/lib/job-status'
import { exitDurationMs } from '@/shared/lib/motion'
import { useFlipList } from '@/shared/hooks/useFlipList'
import { cn } from '@/shared/lib/cn'
import { isVideoOutput, outputUrl } from '@/shared/types'
import type { GenerationJob } from '@/shared/types'

const LINGER_MS = 6000
/** Elapsed-clock refresh. Lives in `ElapsedClock`, so only the clock text re-renders. */
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

export function ActiveJobsBoard(props: ActiveJobsBoardProps) {
  const {
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
  } = props
  // Finished rows linger for LINGER_MS, then fade (`exit`) and leave. Each row's exit
  // is a pair of timers scheduled once, when the row finishes: nothing here ticks.
  const [lingering, setLingering] = useState<Record<string, 'linger' | 'exit'>>({})
  const exitTimers = useRef(new Map<string, number[]>())
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

  useEffect(() => {
    const timers = exitTimers.current
    return () => {
      for (const pair of timers.values()) pair.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    const ids = new Set(activeSignature ? activeSignature.split(',') : [])
    const finished = previousActiveIds.current
      ? [...previousActiveIds.current].filter((id) => !ids.has(id))
      : []

    // A job that is active again (a retry) leaves the linger list at once.
    for (const id of ids) {
      exitTimers.current.get(id)?.forEach((timer) => window.clearTimeout(timer))
      exitTimers.current.delete(id)
    }
    setLingering((current) => {
      const revived = [...ids].filter((id) => id in current)
      if (revived.length === 0) return current
      const next = { ...current }
      for (const id of revived) delete next[id]
      return next
    })

    if (finished.length > 0) {
      for (const id of finished) {
        exitTimers.current.get(id)?.forEach((timer) => window.clearTimeout(timer))
        const fade = window.setTimeout(() => {
          setLingering((current) => (current[id] === 'linger' ? { ...current, [id]: 'exit' } : current))
        }, LINGER_MS)
        // Removal waits out the exit fade, so a row is never cut off mid-fade. Focus
        // moves to the heading first if the row is being removed while focused.
        const remove = window.setTimeout(() => {
          exitTimers.current.delete(id)
          const holdsFocus = document.querySelector(`[data-job-row="${id}"]:focus-within`)
          setLingering((current) => {
            if (!(id in current)) return current
            const next = { ...current }
            delete next[id]
            return next
          })
          if (holdsFocus) headingRef.current?.focus()
        }, LINGER_MS + exitDurationMs())
        exitTimers.current.set(id, [fade, remove])
      }
      setLingering((current) => {
        const next = { ...current }
        for (const id of finished) next[id] = 'linger'
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

  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const finishedRows = lingeringIds
    .map((id) => jobsById.get(id))
    .filter((job): job is GenerationJob => Boolean(job) && !isJobActive(job!))
  const rows = [...activeJobs, ...finishedRows]
  const listRef = useRef<HTMLUListElement>(null)
  // Order-only trigger: only the ids join (add / settle / expiry) re-measures. Clock
  // ticks live in `ElapsedClock` and never reach this effect.
  useFlipList(listRef, rows.map((job) => job.id).join(','))

  if (hideWhenEmpty && rows.length === 0 && !isLoading && !isError) return null

  const heading = isRail ? (
    <div className="mb-3 flex items-center gap-1.5 px-1">
      <h2 id={headingId} className="text-sm font-medium text-foreground">进行中</h2>
      {count > 0 && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </div>
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
          ref={listRef}
          role="list"
          className={cn(
            'm-0 list-none flex flex-col gap-1 overflow-y-auto p-0',
            !open && 'hidden',
            isRail && 'max-h-64',
          )}
        >
          {rows.map((job) =>
            isRail ? (
              <CompactActiveJobRow
                key={job.id}
                job={job}
                exiting={lingering[job.id] === 'exit'}
                selected={job.id === selectedJobId}
                onSelectJob={onSelectJob}
                onCancel={onCancel}
                onRetry={onRetry}
                pendingCancelId={pendingCancelId}
                pendingRetryId={pendingRetryId}
                disabled={disabled}
                actionError={actionErrors[job.id]}
              />
            ) : (
              <ActiveJobRow
                key={job.id}
                job={job}
                exiting={lingering[job.id] === 'exit'}
                selected={job.id === selectedJobId}
                onSelectJob={onSelectJob}
                onCancel={onCancel}
                onRetry={onRetry}
                pendingCancelId={pendingCancelId}
                pendingRetryId={pendingRetryId}
                disabled={disabled}
                actionError={actionErrors[job.id]}
              />
            ),
          )}
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
    <section aria-labelledby={headingId} className="flex min-h-0 shrink-0 flex-col gap-1 px-4 pb-2">
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

/**
 * Elapsed `MM:SS`. The clock owns its 500ms tick, so a tick re-renders this text
 * node only, never the row, the list or the FLIP-measured order. It freezes at
 * `completedAt`, which the worker writes once the job settles.
 */
function ElapsedClock({ job, className }: { job: GenerationJob; className?: string }) {
  const settled = Boolean(job.completedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (settled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [settled])
  const end = job.completedAt ? Date.parse(job.completedAt) : now
  return <span className={className}>{formatElapsed(job, end)}</span>
}

interface ActiveJobRowProps {
  job: GenerationJob
  /** The row is fading out after its linger; set by the board's exit timer. */
  exiting: boolean
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
  exiting,
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
    // FLIP owns the outer `li` (`data-flip-key`); the exit fade stays on the
    // inner node so WAAPI transforms are never overridden by the keyframe.
    <li data-job-row={job.id} data-flip-key={job.id} className="relative">
      <div
        className={cn(
          'flex gap-3 rounded-control p-3',
          // The row leaves on the `--motion-exit` token once its linger ends. The
          // board's exit timer sets `exiting`, so the fade never depends on a tick.
          exiting && 'motion-fade-out',
          selected ? 'bg-tonal-selected' : active ? 'bg-tonal' : 'bg-neutral-soft',
        )}
      >
      {firstOutput ? (
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
      ) : active ? (
        // No output yet: a shimmering placeholder keeps the row's shape while the
        // worker is still producing. Static under reduced motion (global rule).
        <div aria-hidden="true" className="relative h-12 w-12 shrink-0 overflow-hidden rounded-control bg-tonal">
          <span className="motion-shimmer absolute inset-0" />
        </div>
      ) : (
        <div aria-hidden="true" className="h-12 w-12 shrink-0 rounded-control bg-neutral-soft" />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <JobStatusBadge status={job.status} busy={active} />
          {stage ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{stage}</span>
          ) : null}
          <ElapsedClock job={job} className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground" />
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
      </div>
    </li>
  )
}

function CompactActiveJobRow({
  job,
  exiting,
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
  const statusText = active
    ? job.status === 'queued'
      ? '排队中'
      : job.status === 'retry_wait'
        ? '等待重试'
        : '生成中'
    : job.status === 'succeeded'
      ? '已完成'
      : job.status === 'failed'
        ? '失败'
        : '已取消'
  // Queued rows carry a landscape 48×27 slot; running and finished rows a 36×48 portrait one.
  const thumbSize = job.status === 'queued' ? 'h-[27px] w-12' : 'h-12 w-9'
  const highlighted = selected || (active && job.status !== 'queued')

  return (
    <li data-job-row={job.id} data-flip-key={job.id} className="relative">
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-control p-2.5 transition-colors',
          exiting && 'motion-fade-out',
          highlighted ? 'bg-tonal-selected' : 'bg-transparent hover:bg-tonal-hover',
        )}
      >
        {firstOutput ? (
          <button
            type="button"
            onClick={() => onSelectJob(job.id)}
            disabled={disabled}
            className={cn('block shrink-0 overflow-hidden rounded-control bg-surface', thumbSize)}
            aria-label={`查看结果：${job.prompt.slice(0, 20)}`}
          >
            <MediaFrame
              src={outputUrl(firstOutput)}
              kind={firstOutput.mediaKind}
              alt=""
              layout="thumb"
            />
          </button>
        ) : active ? (
          <div aria-hidden="true" className={cn('relative shrink-0 overflow-hidden rounded-control bg-tonal', thumbSize)}>
            <span className="motion-shimmer absolute inset-0" />
          </div>
        ) : (
          <div aria-hidden="true" className={cn('shrink-0 rounded-control bg-tonal', thumbSize)} />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onSelectJob(job.id)}
            disabled={disabled}
            aria-current={selected ? 'true' : undefined}
            className="min-w-0 truncate text-left text-[13px] font-normal text-foreground"
          >
            {job.prompt}
          </button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{statusText}</span>
            <ElapsedClock job={job} className="font-mono tabular-nums" />
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1">
          {active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onCancel(job.id)}
              disabled={disabled || Boolean(job.cancelRequested) || Boolean(pendingCancelId)}
              loading={pendingCancelId === job.id}
              aria-label={`取消任务：${job.prompt.slice(0, 20)}`}
              className="h-6 px-1.5 text-xs text-muted-foreground hover:text-danger"
              icon={<XCircle weight="bold" aria-hidden="true" className="h-3.5 w-3.5" />}
            />
          )}
          {job.status === 'failed' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRetry(job.id)}
              loading={pendingRetryId === job.id}
              disabled={disabled || Boolean(pendingRetryId)}
              aria-label={`重试任务：${job.prompt.slice(0, 20)}`}
              className="h-6 px-1.5 text-xs"
              icon={<RefreshCw weight="bold" aria-hidden="true" className="h-3.5 w-3.5" />}
            />
          )}
        </div>
      </div>
      {actionError && <p role="alert" className="mt-1 text-xs text-danger">{actionError}</p>}
    </li>
  )
}
