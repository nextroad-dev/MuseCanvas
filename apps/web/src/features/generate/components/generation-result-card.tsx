'use client'

import { useEffect, useState } from 'react'
import { ArrowSquareOutIcon, DownloadSimpleIcon, SparkleIcon, StopCircleIcon } from '@phosphor-icons/react'
import { Button, buttonVariants } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { formatElapsed, isJobActive, phaseLabel } from '@/shared/lib/job-status'
import { useCancelJobMutation, useJobsQuery } from '@/shared/hooks/useJobs'
import { isVideoOutput, outputPoster, outputUrl } from '@/shared/types'
import type { GenerationJob } from '@/shared/types'
import { GenerationFrame, framePhaseForStatus, frameSizeLabel, resolveFrameAspect } from './generation-frame'

export interface GenerationResultCardProps {
  jobId: string
  /** Opens the result dialog (original media + metadata + region edit entry). */
  onOpenResult: (job: GenerationJob) => void
  /** Explicit "continue planning" action. Never fired automatically. */
  onContinuePlanning: (job: GenerationJob) => void
  /** Aborts only the current Agent turn; it does not cancel a created media job. */
  onStopAgentTurn: () => void
  streaming: boolean
  /** False when the Agent is disabled/unconfigured: the continuation is not offered. */
  canContinue: boolean
}

const STEPS = ['排队等待', '模型生成', '保存结果'] as const

/** Step cursor: which of the three stages is current, or 3 when all are done. */
function stepCursor(job: GenerationJob): number {
  if (job.status === 'succeeded') return STEPS.length
  if (job.status === 'failed' || job.status === 'canceled') return -1
  if (job.status === 'queued' || job.status === 'retry_wait') return 0
  return 1
}

/**
 * A created generation job as a result entry. Every job fact (status, output,
 * errors) comes from the shared `useJobsQuery` — the Agent stream never invents job
 * outcomes. Cancel targets the media job; stopping the Agent turn is a separate,
 * clearly-labelled action that cannot cancel the job.
 *
 * The media box is one `GenerationFrame` for the whole job life: it reserves the
 * target aspect while generating and fades the output in inside the same box, so
 * `running → succeeded` never moves surrounding content.
 */
export function GenerationResultCard({ jobId, onOpenResult, onContinuePlanning, onStopAgentTurn, streaming, canContinue }: GenerationResultCardProps) {
  // Same query key as the console (limit 30) so TanStack dedupes one jobs list and
  // one polling timer instead of two parallel fetches while a job is active.
  const { data: jobs = [], isLoading } = useJobsQuery(30)
  const cancelJob = useCancelJobMutation()
  const job = jobs.find((entry) => entry.id === jobId)
  const [now, setNow] = useState(() => Date.now())

  const active = job ? isJobActive(job) : false
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active])

  if (!job) {
    return (
      <article className="motion-reveal rounded-panel bg-tonal p-4">
        <p className="text-sm text-muted-foreground">{isLoading ? '正在加载任务状态…' : `任务 ${jobId} 暂时不可用，请重载任务列表。`}</p>
      </article>
    )
  }

  const output = job.outputs[0]
  const phase = framePhaseForStatus(job.status)
  const aspect = resolveFrameAspect(job)
  const video = output ? isVideoOutput(output) : job.mediaKind === 'video'
  const cursor = stepCursor(job)
  const clockEnd = job.completedAt ? Date.parse(job.completedAt) : now
  const liveText = job.status === 'succeeded'
    ? '生成完成，结果已保存到图库。'
    : job.status === 'failed'
      ? (job.errorMessage ?? job.errorCode ?? '生成失败')
      : '完成后会在这里显示，并自动保存到图库。'

  return (
    <article aria-label="生成结果" className="motion-reveal flex flex-col gap-3 rounded-panel bg-tonal p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{job.modelName || '生成结果'}</h3>
        <JobStatusBadge status={job.status} busy={active} />
        <span className="ml-auto truncate font-mono text-caption tabular-nums text-muted-foreground" title={job.id}>{job.id}</span>
      </header>

      <div className="flex flex-wrap items-start gap-4">
        <GenerationFrame
          aspect={aspect}
          phase={phase}
          phaseText={active ? `${phaseLabel(job.phase)}…` : ''}
          sizeLabel={active ? frameSizeLabel(job) : undefined}
          src={output ? outputUrl(output) : undefined}
          video={video}
          alt={job.prompt}
          poster={output ? outputPoster(output) : undefined}
          errorText={job.status === 'failed' ? (job.errorMessage ?? job.errorCode ?? '生成失败') : undefined}
          onOpen={output ? () => onOpenResult(job) : undefined}
        />

        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-caption tabular-nums text-muted-foreground">{formatElapsed(job, clockEnd)}</span>
            {active ? <span className="text-xs text-muted-foreground">{phaseLabel(job.phase)}</span> : null}
          </div>

          {cursor >= 0 ? (
            <ol aria-label="任务阶段" className="m-0 flex list-none flex-col gap-2 p-0">
              {STEPS.map((label, index) => {
                const done = index < cursor
                const current = index === cursor
                return (
                  <li key={label} className="flex items-center gap-2.5 text-sm">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-pill',
                        done && 'bg-accent',
                        current && 'bg-primary ring-2 ring-tonal',
                        !done && !current && 'bg-border',
                      )}
                    />
                    <span className={done || current ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
                  </li>
                )
              })}
            </ol>
          ) : null}

          <p role="status" aria-live="polite" className="text-caption text-muted-foreground">{liveText}</p>

          <div className="flex flex-wrap items-center gap-2">
            {output ? (
              <Button variant="secondary" size="sm" onClick={() => onOpenResult(job)} icon={<ArrowSquareOutIcon weight="bold" aria-hidden="true" />}>
                查看与编辑
              </Button>
            ) : null}
            {output ? (
              <a href={output.downloadUrl || outputUrl(output)} download target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                <DownloadSimpleIcon weight="bold" aria-hidden="true" />{isVideoOutput(output) ? '下载视频' : '下载原图'}
              </a>
            ) : null}
            {job.status === 'succeeded' ? (
              <Button variant="primary" size="sm" disabled={streaming || !canContinue} onClick={() => onContinuePlanning(job)} icon={<SparkleIcon weight="bold" aria-hidden="true" />}>
                继续规划
              </Button>
            ) : null}
            {active ? (
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={cancelJob.isPending || Boolean(job.cancelRequested)}
                loading={cancelJob.isPending && cancelJob.variables === job.id}
                onClick={() => cancelJob.mutate(job.id)}
              >
                {job.cancelRequested ? '取消中' : '取消生成任务'}
              </Button>
            ) : null}
            {streaming ? (
              <Button variant="ghost" size="sm" onClick={onStopAgentTurn} icon={<StopCircleIcon weight="bold" aria-hidden="true" />}>
                停止本轮 Agent
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <p className="text-caption text-muted-foreground">停止本轮只中止 Agent 对话请求，不会取消已创建的生成任务；取消任务请使用“取消生成任务”。</p>
    </article>
  )
}
