import type { PublicModelDto } from '@/shared/types'

export const PROMPT_LIMIT = 8_000

export function imageModelBlockReason(model: PublicModelDto | null | undefined): string | null {
  if (!model) return '暂无可用的文生图模型，请联系管理员配置。'
  if (!model.enabled || model.deprecated) return '该模型已停用或下架，请选择其他模型。'
  if (model.modelKind !== 'image' || !model.modes.includes('text_to_image')) return '此模型不支持文生图，请选择其他模型。'
  if (model.declaredBy === 'undeclared') return '模型能力尚未通过校验，请联系管理员。'
  if (model.inputSlots.some((slot) => slot.required || slot.minCount > 0)) return '此模型需要参考素材；当前创作台暂不支持上传，请选择文生图模型。'
  return null
}

export function promptIssue(prompt: string): string | null {
  if (!prompt.trim()) return '请先描述你想创作的画面。'
  if (prompt.length > PROMPT_LIMIT) return `提示词不能超过 ${PROMPT_LIMIT.toLocaleString('en-US')} 个字符。`
  return null
}

/** Stable completion identity: partial output imports also refresh the library. */
export function completionSignature(jobs: readonly { id: string; status: string; outputs: readonly { assetId: string }[] }[]): string {
  return jobs.filter((job) => job.status === 'succeeded' || job.outputs.length > 0)
    .map((job) => `${job.id}:${job.status}:${job.outputs.map((output) => output.assetId).join(',')}`).sort().join('|')
}
