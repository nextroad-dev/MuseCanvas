import type { JobStatus } from '@/shared/types'

const PHASE_LABELS: Record<string, string> = {
  template_selecting: '正在匹配提示词模板',
  template_selected: '模板已匹配',
  prompt_optimizing: '正在优化提示词',
  prompt_ready: '提示词已就绪',
  image_generating: '正在生成图片',
  asset_persisting: '正在保存结果',
  completed: '处理完成',
}

const CANCELLABLE_STATUSES = new Set<JobStatus>(['queued', 'retry_wait'])

export function phaseLabel(phase?: string | null) {
  return phase ? PHASE_LABELS[phase] || '正在处理' : '正在处理'
}

export function canCancelJob(status?: JobStatus | null) {
  return !!status && CANCELLABLE_STATUSES.has(status)
}
