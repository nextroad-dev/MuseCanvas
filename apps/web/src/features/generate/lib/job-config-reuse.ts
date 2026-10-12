import { canonicalNameOf, reconcileModelParameters } from '../../../shared/lib/media-parameters'
import type { ParameterState } from '../../../shared/lib/media-parameters'
import { isVideoOutput, modelMediaKind } from '../../../shared/types'
import type { GenerateModeTab, GenerationJob, ModelConfig } from '../../../shared/types'

export interface JobConfigReuse {
  prompt: string
  tab: GenerateModeTab
  model: ModelConfig | null
  parameters: ParameterState
  notices: string[]
}

/** Restore a draft, never a submitted request or a historical edit selection. */
export function buildJobConfigReuse(job: GenerationJob, models: ModelConfig[]): JobConfigReuse {
  const tab: GenerateModeTab = job.mediaKind === 'video'
    || (job.mediaKind == null && job.outputs.some(isVideoOutput)) ? 'video' : 'image'
  const model = models.find((entry) => entry.id === job.modelId && modelMediaKind(entry) === tab) ?? null
  const notices = ['未恢复参考图或编辑选区；请检查后再生成。']
  if (job.inputs?.length || job.inputImages?.length) {
    notices.push('这次历史任务包含输入图片，请重新添加所需参考图或输入画面。')
  }
  if (!model) {
    notices.push('历史模型当前不可用，只能使用提示词；请自行选择可用模型。')
    return { prompt: job.inputPrompt ?? job.prompt, tab, model: null, parameters: {}, notices }
  }

  const raw = job.parameters ?? {
    ...(job.size != null ? { size: job.size } : {}),
    ...(job.quality != null ? { quality: job.quality } : {}),
    ...(job.count != null ? { count: job.count } : {}),
  }
  const values: ParameterState = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) {
      values[canonicalNameOf({ name })] = value
    }
  }
  const parameters = reconcileModelParameters(model, values)
  const dropped = Object.keys(raw).filter((name) => !(canonicalNameOf({ name }) in parameters))
  if (dropped.length > 0) notices.push(`未恢复不兼容参数：${dropped.join('、')}；使用当前模型默认值。`)
  if (!job.parameters) notices.push('旧任务未记录完整参数，仅恢复可校验的已有值，其余使用当前模型默认值。')
  return { prompt: job.inputPrompt ?? job.prompt, tab, model, parameters, notices }
}
