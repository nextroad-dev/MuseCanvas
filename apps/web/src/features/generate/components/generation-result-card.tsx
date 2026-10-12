'use client'

import { ArrowSquareOutIcon, DownloadSimpleIcon, MagnifyingGlassPlusIcon, SparkleIcon, StopCircleIcon } from '@phosphor-icons/react'
import { Button, buttonVariants, iconSize } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { MediaFrame } from '@/shared/components/media-frame'
import { isJobActive } from '@/shared/lib/job-status'
import { useCancelJobMutation, useJobsQuery } from '@/shared/hooks/useJobs'
import { isVideoOutput, outputUrl } from '@/shared/types'
import type { GenerationJob } from '@/shared/types'

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

/**
 * A created generation job as a result entry. Every job fact (status, output,
 * errors) comes from the shared `useJobsQuery` — the Agent stream never invents job
 * outcomes. Cancel targets the media job; stopping the Agent turn is a separate,
 * clearly-labelled action that cannot cancel the job.
 */
export function GenerationResultCard({ jobId, onOpenResult, onContinuePlanning, onStopAgentTurn, streaming, canContinue }: GenerationResultCardProps) {
  // Same query key as the console (limit 30) so TanStack dedupes one jobs list and
  // one polling timer instead of two parallel fetches while a job is active.
  const { data: jobs = [], isLoading } = useJobsQuery(30)
  const cancelJob = useCancelJobMutation()
  const job = jobs.find((entry) => entry.id === jobId)

  if (!job) {
    return (
      <article className="motion-reveal rounded-panel bg-tonal p-4">
        <p className="text-sm text-muted-foreground">{isLoading ? '正在加载任务状态…' : `任务 ${jobId} 暂时不可用，请重载任务列表。`}</p>
      </article>
    )
  }

  const output = job.outputs[0]
  const active = isJobActive(job)

  return (
    <article aria-label="生成结果" className="motion-reveal flex flex-col gap-3 rounded-panel bg-tonal p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{job.modelName || '生成结果'}</h3>
        <JobStatusBadge status={job.status} busy={active} />
        <span className="ml-auto truncate font-mono text-caption text-muted-foreground" title={job.id}>{job.id}</span>
      </header>

      {output ? (
        <button
          type="button"
          onClick={() => onOpenResult(job)}
          className="group relative block w-full max-w-xs overflow-hidden rounded-control bg-tonal"
          aria-label="查看原图与元信息"
        >
          <MediaFrame src={outputUrl(output)} kind={isVideoOutput(output) ? 'video' : 'image'} alt={job.prompt} layout="tile" showControls={false} />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/25 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-hover-fade" aria-hidden="true">
            <MagnifyingGlassPlusIcon weight="bold" aria-hidden="true" className={cn(iconSize.lg, 'text-on-media')} />
          </span>
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">{job.status === 'failed' ? (job.errorMessage ?? job.errorCode ?? '生成失败') : active ? '正在生成，完成后可查看结果。' : '暂无产物。'}</p>
      )}

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
      <p className="text-caption text-muted-foreground">停止本轮只中止 Agent 对话请求，不会取消已创建的生成任务；取消任务请使用“取消生成任务”。</p>
    </article>
  )
}
