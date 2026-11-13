'use client'

import { useState } from 'react'
import { ArrowCounterClockwiseIcon, DownloadSimpleIcon, ImageIcon } from '@phosphor-icons/react'
import { Alert, Badge, Button, Dialog, Spinner, buttonVariants } from '@/shared/components/ui'
import { useCancelJob, useDeleteJob, useRetryJob } from '@/shared/hooks/useJobs'
import { isJobActive, jobStatusLabel, jobStatusTone, phaseLabel } from '@/shared/lib/job-status'
import { formatSizeLabel } from '@/shared/lib/generation-params'
import type { GenerationJobDto, GenerationOutput } from '@/shared/types'

function ResultImage({ output, prompt, onView }: { output: GenerationOutput; prompt: string; onView: () => void }) {
  const [failed, setFailed] = useState(false)
  return <button type="button" onClick={onView} aria-label="放大查看生成图片" className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-control bg-tonal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus">
    {failed ? <span className="px-4 text-sm text-muted-foreground">图片无法加载，仍可尝试下载原图</span> : <img src={output.url} alt={prompt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />}
  </button>
}

export function GenerationTask({ job, onReuse }: { job: GenerationJobDto; onReuse: (job: GenerationJobDto) => void }) {
  const cancel = useCancelJob()
  const retry = useRetryJob()
  const remove = useDeleteJob()
  const [preview, setPreview] = useState<GenerationOutput | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const active = isJobActive(job)
  const error = cancel.error ?? retry.error ?? remove.error
  const busy = cancel.isPending || retry.isPending || remove.isPending
  const images = job.outputs.filter((output) => output.mediaKind === 'image')

  return <article className="min-w-0 space-y-4 rounded-panel bg-surface p-4 shadow-soft sm:p-5" aria-label={`${job.modelName}：${jobStatusLabel(job.status)}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{job.modelName}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{formatSizeLabel(job.size, job.count)}</p></div>
      <Badge tone={jobStatusTone(job.status)} dot>{job.cancelRequested && active ? '取消请求已提交' : jobStatusLabel(job.status)}</Badge>
    </div>
    <p className="line-clamp-3 break-words text-sm text-foreground">{job.inputPrompt || job.prompt}</p>
    {images.length > 0 && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {images.map((output) => <div key={output.assetId} className="min-w-0 space-y-2">
        <ResultImage output={output} prompt={job.inputPrompt || job.prompt} onView={() => setPreview(output)} />
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => setPreview(output)}>查看大图</Button><a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={output.downloadUrl || output.url} download rel="noreferrer" target="_blank"><DownloadSimpleIcon aria-hidden="true" className="size-4" />下载原图</a></div>
      </div>)}
    </div>}
    {active && <div className="flex items-center gap-3 rounded-control bg-tonal p-4 text-sm text-muted-foreground" role="status"><Spinner size="sm" />{job.cancelRequested ? '正在等待取消确认，请稍候。' : phaseLabel(job.phase)}</div>}
    {job.status === 'failed' && <Alert tone="danger" title="本次生成未完成">{job.errorMessage || '生成服务暂时不可用，可以重试或调整提示词。'}</Alert>}
    {job.status === 'canceled' && <p className="text-sm text-muted-foreground">任务已取消。提示词仍可复用，或重试此任务。</p>}
    {job.status === 'succeeded' && images.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><ImageIcon aria-hidden="true" className="size-4" />{job.mediaKind === 'video' ? '视频任务请前往图库查看。' : '此任务没有可展示的图片。'}</p>}
    {error && <Alert tone="danger" title="操作失败">{error instanceof Error ? error.message : '请稍后重试。'}</Alert>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" onClick={() => onReuse(job)}>复用提示词</Button>
      {active ? <Button size="sm" variant="secondary" disabled={busy || job.cancelRequested} loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>取消任务</Button> : <>
        {(job.status === 'failed' || job.status === 'canceled') && <Button size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon aria-hidden="true" className="size-4" />} disabled={busy} loading={retry.isPending} onClick={() => retry.mutate(job.id)}>重试任务</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>删除任务与作品</Button>
      </>}
    </div>
    <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} title="作品预览" description="保留原始比例显示。下载将打开原始资源。" size="wide" footer={<><Button variant="secondary" onClick={() => { onReuse(job); setPreview(null) }}>复用提示词</Button>{preview && <a className={buttonVariants({ size: 'md', variant: 'primary' })} href={preview.downloadUrl || preview.url} download target="_blank" rel="noreferrer">下载原图</a>}</>}>
      {preview && <img src={preview.url} alt={job.inputPrompt || job.prompt} className="max-h-[60vh] w-full rounded-control object-contain" />}<p className="mt-4 break-words text-sm text-muted-foreground">{job.inputPrompt || job.prompt}</p>
    </Dialog>
    <Dialog open={confirmDelete} onClose={() => { if (!remove.isPending) setConfirmDelete(false) }} title="删除任务与关联作品？" description="此操作不可撤销，同时会从图库删除本任务的所有作品。请先下载需要保留的图片。" footer={<><Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirmDelete(false)}>保留任务</Button><Button loading={remove.isPending} onClick={() => remove.mutate(job.id, { onSuccess: () => setConfirmDelete(false) })}>确认删除</Button></>}>
      <p className="break-words text-sm text-muted-foreground">{job.inputPrompt || job.prompt}</p>
      {remove.error && <Alert tone="danger">{remove.error instanceof Error ? remove.error.message : '删除失败，请重试。'}</Alert>}
    </Dialog>
  </article>
}
