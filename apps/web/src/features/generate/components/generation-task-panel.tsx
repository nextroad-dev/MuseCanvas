'use client'

import { Alert, Button, Dialog, EmptyState, SkeletonRow } from '@/shared/components/ui'
import { MediaFrame } from '@/shared/components/media-frame'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { isJobActive } from '@/shared/lib/job-status'
import { cn } from '@/shared/lib/cn'
import { isVideoOutput, outputUrl } from '@/shared/types'
import type { GenerationJob } from '@/shared/types'
import { ActiveJobsBoard } from './active-jobs-board'
import type { ActiveJobsBoardProps } from './active-jobs-board'

export interface GenerationTaskPanelProps extends ActiveJobsBoardProps {
  open: boolean
  onClose: () => void
  busy: boolean
  actionErrors: Record<string, string>
  /** Seeds the Agent composer draft from a historical job. Never submits. */
  onReuseJob: (job: GenerationJob) => void
}

export function GenerationTaskPanel({ open, onClose, busy, actionErrors, onReuseJob, ...board }: GenerationTaskPanelProps) {
  return (
    <Dialog open={open} onClose={onClose} title="既有任务" size="wide" description={`最近 30 条已加载任务（当前 ${board.jobs.length} 条）；运行数仅统计这份列表，并非全量队列。旧任务不会迁入 Agent 历史，可查看结果或复用到草稿。`}>
      <ActiveJobsBoard {...board} actionErrors={actionErrors} disabled={busy} variant="inline" open />
      <h3 className="mb-3 mt-6 text-sm font-medium text-foreground">最近记录</h3>
      {board.isLoading && board.jobs.length === 0 ? <SkeletonRow cells={3} /> : board.jobs.length === 0 ? <EmptyState density="compact" variant="first-use" title="还没有生成记录" description="提交后可在此查看任务，查看记录不会更改草稿。" /> : (
        <ul className="flex flex-col gap-2">
          {board.jobs.map((job) => {
            const output = job.outputs?.[0]
            return <li key={job.id} className={cn('flex flex-col gap-2 rounded-control p-3', job.id === board.selectedJobId ? 'bg-tonal-selected' : 'bg-tonal')}>
              <button type="button" disabled={busy} onClick={() => { board.onSelectJob(job.id); onClose() }} aria-current={job.id === board.selectedJobId ? 'true' : undefined} className="flex w-full min-w-0 items-center gap-3 text-left">
                {output && <span className="h-12 w-12 shrink-0 overflow-hidden rounded-control"><MediaFrame src={outputUrl(output)} kind={isVideoOutput(output) ? 'video' : 'image'} alt="" layout="thumb" /></span>}
                <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="line-clamp-2 break-words text-sm text-foreground">{job.inputPrompt ?? job.prompt}</span><span className="truncate text-xs text-muted-foreground">{job.modelName} · {new Date(job.createdAt).toLocaleString()}</span></span>
                <JobStatusBadge status={job.status} />
              </button>
              <div className="flex flex-wrap gap-2">
                {output ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => { board.onSelectJob(job.id); onClose() }}>查看结果</Button> : null}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onReuseJob(job); onClose() }}>使用这次配置</Button>
                {isJobActive(job) && <Button variant="danger-ghost" size="sm" onClick={() => board.onCancel(job.id)} loading={board.pendingCancelId === job.id} disabled={busy || Boolean(job.cancelRequested) || Boolean(board.pendingCancelId)}>{job.cancelRequested ? '取消中' : '取消任务'}</Button>}
                {job.status === 'failed' && <Button variant="secondary" size="sm" onClick={() => board.onRetry(job.id)} loading={board.pendingRetryId === job.id} disabled={busy || Boolean(board.pendingRetryId)}>重试原任务</Button>}
              </div>
              {actionErrors[job.id] && <Alert tone="danger" role="alert">{actionErrors[job.id]}</Alert>}
            </li>
          })}
        </ul>
      )}
    </Dialog>
  )
}
