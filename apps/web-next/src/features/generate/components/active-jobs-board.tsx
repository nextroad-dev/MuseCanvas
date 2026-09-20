'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, RefreshCw, XCircle } from 'lucide-react'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { MediaFrame } from '@/shared/components/media-frame'
import { formatElapsed, isJobActive, phaseLabel } from '@/shared/lib/job-status'
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
  /** `rail` collapses; `inline` is the <768px copy and stays open. */
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

  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-h-0 shrink-0 flex-col ${
        isRail ? '' : 'rounded-[var(--radius-card)] border border-border bg-surface'
      }`}
    >
      {isRail ? (
        <h2 id={headingId} className="shrink-0 px-2 pt-2 text-sm">
          <button
            ref={headingRef}
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => onToggle?.(!open)}
            className="flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-1.5 text-left text-sm font-medium text-foreground hover:bg-surface-subtle"
          >
            <ChevronRight
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] ${
                open ? 'rotate-90' : ''
              }`}
              aria-hidden="true"
            />
            <span>进行中</span>
            {count > 0 && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
            )}
          </button>
        </h2>
      ) : (
        <h2
          id={headingId}
          className="flex shrink-0 items-center gap-2 px-3 pt-3 text-sm text-foreground"
        >
          进行中
          {count > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
        </h2>
      )}

      {isError ? (
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <p className="min-w-0 text-xs text-muted-foreground">任务列表获取失败</p>
          <button
            type="button"
            onClick={onReload}
            className="flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 text-xs font-medium text-foreground hover:bg-surface-subtle"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            重试
          </button>
        </div>
      ) : rows.length === 0 && !open ? null : rows.length === 0 ? (
        <div className="px-3 pb-3 pt-2">
          {isLoading ? (
            <div aria-busy="true" className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">加载任务中…</p>
              <div aria-hidden="true" className="flex flex-col gap-2">
                <span className="h-4 w-24 rounded-[var(--radius-pill)] bg-surface-subtle" />
                <span className="h-4 w-full rounded bg-surface-subtle" />
                <span className="h-3 w-2/3 rounded bg-surface-subtle" />
              </div>
              <div aria-hidden="true" className="flex flex-col gap-2">
                <span className="h-4 w-20 rounded-[var(--radius-pill)] bg-surface-subtle" />
                <span className="h-4 w-5/6 rounded bg-surface-subtle" />
                <span className="h-3 w-1/2 rounded bg-surface-subtle" />
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">当前没有进行中的任务</p>
          )}
        </div>
      ) : (
        <ul
          id={listId}
          role="list"
          className={`m-0 list-none divide-y divide-border overflow-y-auto p-0 ${
            open ? '' : 'hidden'
          } ${isRail ? 'max-h-64' : ''}`}
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
            />
          ))}
        </ul>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
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
}: ActiveJobRowProps) {
  const active = isJobActive(job)
  const firstOutput = job.outputs?.[0]
  const cancelling = Boolean(job.cancelRequested) || pendingCancelId === job.id
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

  const meta = [job.modelName, job.size, Number.isFinite(job.count) ? `${job.count} ${unit}` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <li
      data-job-row={job.id}
      className={`relative flex gap-2 p-3 transition-opacity duration-[var(--motion-slow)] ease-[var(--ease-standard)] ${
        expiringAt !== undefined && expiringAt - now <= FADE_MS ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-0 w-[3px] rounded-[var(--radius-pill)] bg-accent"
        />
      )}

      {firstOutput && (
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-subtle">
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

        <button
          type="button"
          onClick={() => onSelectJob(job.id)}
          aria-current={selected ? 'true' : undefined}
          className="line-clamp-2 min-w-0 text-left text-sm leading-[1.5] text-foreground hover:text-accent-strong"
        >
          {job.prompt}
        </button>

        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</p>

          {active && (
            <button
              type="button"
              onClick={() => onCancel(job.id)}
              disabled={cancelling}
              aria-label={`取消任务：${job.prompt.slice(0, 20)}`}
              className="flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 text-xs font-medium text-danger hover:bg-danger-soft disabled:text-muted-foreground disabled:hover:bg-transparent"
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              {cancelling ? '取消中' : '取消'}
            </button>
          )}

          {job.status === 'failed' && (
            <button
              type="button"
              onClick={() => onRetry(job.id)}
              disabled={pendingRetryId === job.id}
              aria-label={`重试任务：${job.prompt.slice(0, 20)}`}
              className="flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 text-xs font-medium text-foreground hover:bg-surface-subtle"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              重试
            </button>
          )}
        </div>

        {job.status === 'failed' && job.errorMessage && (
          <p className="line-clamp-1 text-xs text-danger">{job.errorMessage}</p>
        )}
      </div>
    </li>
  )
}
