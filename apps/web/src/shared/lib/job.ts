import type { JobStatus } from '@/shared/types'

const PHASE_LABELS: Record<string, string> = {
  queued: '任务已加入队列，等待开始处理',
  template_selecting: '正在匹配提示词模板',
  template_selected: '已匹配提示词模板',
  template_skipped: '已使用默认优化流程',
  prompt_optimizing: '正在优化提示词表达',
  prompt_ready: '提示词已准备完成',
  image_generating: '模型正在生成图片',
  asset_persisting: '图片已生成，正在安全保存',
  completed: '生成完成',
  retry_wait: '服务短暂繁忙，系统正在自动重试',
  template_failed: '提示词模板暂时不可用',
  optimization_failed: '提示词优化暂时不可用',
  generation_failed: '图片生成失败',
}

const CANCELLABLE_STATUSES = new Set<JobStatus>(['queued', 'retry_wait', 'running'])

export function phaseLabel(phase?: string | null) {
  return phase ? PHASE_LABELS[phase] || '正在处理' : '正在处理'
}

export function canCancelJob(status?: JobStatus | null) {
  return !!status && CANCELLABLE_STATUSES.has(status)
}
