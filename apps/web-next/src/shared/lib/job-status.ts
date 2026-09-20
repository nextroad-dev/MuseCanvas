import type { GenerationJob, JobStatus } from '@/shared/types'

export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'retry_wait'] as const

export function isJobActive(job: Pick<GenerationJob, 'status'>): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)
}

export interface JobStatusMeta {
  label: string
  /** Foreground/background pair. Each combination clears 4.5:1 at 12px, which is
   *  why `running` uses `text-accent-strong` rather than `text-accent` (3.94:1). */
  badge: string
  dot: string
}

const JOB_STATUS_META: Record<JobStatus, JobStatusMeta> = {
  queued: { label: '排队中', badge: 'bg-info-soft text-info', dot: 'bg-info' },
  running: { label: '生成中', badge: 'bg-accent-soft text-accent-strong', dot: 'bg-accent' },
  retry_wait: { label: '重试等待', badge: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  succeeded: { label: '已完成', badge: 'bg-success-soft text-success', dot: 'bg-success' },
  failed: { label: '失败', badge: 'bg-danger-soft text-danger', dot: 'bg-danger' },
  canceled: { label: '已取消', badge: 'bg-neutral-soft text-neutral-status', dot: 'bg-neutral-status' },
}

export function jobStatusMeta(status: JobStatus): JobStatusMeta {
  return JOB_STATUS_META[status] ?? JOB_STATUS_META.queued
}

const PHASE_LABEL: Record<string, string> = {
  template_selecting: '挑选模板',
  template_selected: '模板已选定',
  template_skipped: '跳过模板',
  template_failed: '模板不可用',
  prompt_optimizing: '优化提示词',
  prompt_ready: '提示词就绪',
  optimization_failed: '提示词优化失败',
  preprocessing: '预处理输入',
  provider_submitting: '提交至生成服务',
  provider_waiting: '等待返回',
  provider_canceling: '取消中',
  artifact_importing: '拉取产物',
  asset_persisting: '保存素材',
  image_generating: '生成图像',
  generation_failed: '生成失败',
  completed: '已完成',
}

/** `phase` is the only truthful stage signal; `progress` is written as 0 or 100
 *  by the worker, so no percentage may be rendered from it. */
export function phaseLabel(phase?: string | null): string {
  return (phase && PHASE_LABEL[phase]) || '准备中'
}

/** `MM:SS` of work spent, measured from `startedAt` and falling back to submission. */
export function formatElapsed(
  job: Pick<GenerationJob, 'startedAt' | 'createdAt'>,
  now: number = Date.now(),
): string {
  const raw = job.startedAt || job.createdAt
  const started = raw ? Date.parse(raw) : NaN
  if (!Number.isFinite(started)) return '00:00'
  const total = Math.max(0, Math.floor((now - started) / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
