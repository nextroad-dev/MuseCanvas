// 任务状态/阶段的文案与语气。颜色不是唯一载体：label 始终随 tone 一起渲染。
// 纯模块（仅 type import），可直接被 `node --test` 加载。

import type { JobStatus } from '@/shared/types'

/** 视为「进行中」的状态：列表轮询与结果卡占位都由它决定。 */
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'retry_wait'] as const

export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export function isJobActive(job: Pick<{ status: JobStatus }, 'status'>): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)
}

export function isJobTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '生成中',
  retry_wait: '重试等待',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const JOB_STATUS_TONE: Record<JobStatus, StatusTone> = {
  queued: 'info',
  running: 'info',
  retry_wait: 'warning',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

export function jobStatusLabel(status: JobStatus | string): string {
  return JOB_STATUS_LABEL[status as JobStatus] ?? '未知状态'
}

export function jobStatusTone(status: JobStatus | string): StatusTone {
  return JOB_STATUS_TONE[status as JobStatus] ?? 'neutral'
}

export function jobStatusMeta(status: JobStatus | string): { label: string; tone: StatusTone } {
  return { label: jobStatusLabel(status), tone: jobStatusTone(status) }
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

const PHASE_TONE: Record<string, StatusTone> = {
  template_selecting: 'info',
  template_selected: 'info',
  template_skipped: 'neutral',
  template_failed: 'warning',
  prompt_optimizing: 'info',
  prompt_ready: 'info',
  optimization_failed: 'warning',
  preprocessing: 'info',
  provider_submitting: 'info',
  provider_waiting: 'info',
  provider_canceling: 'warning',
  artifact_importing: 'info',
  asset_persisting: 'info',
  image_generating: 'info',
  generation_failed: 'danger',
  completed: 'success',
}

/** `phase` 是唯一可信的阶段信号；`progress` 由 worker 写成 0/100，不能当百分比。 */
export function phaseLabel(phase?: string | null): string {
  return (phase && PHASE_LABEL[phase]) || '准备中'
}

export function phaseTone(phase?: string | null): StatusTone {
  return (phase && PHASE_TONE[phase]) || 'neutral'
}

/** JSON 导出（供测试与调试断言用）。 */
export const JOB_STATUS_META = {
  labels: JOB_STATUS_LABEL,
  tones: JOB_STATUS_TONE,
  phases: PHASE_LABEL,
} as const
