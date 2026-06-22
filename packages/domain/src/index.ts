export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled'
export const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'canceled'])

export function validateModelInput(model: { adapter: string; sizes: string[]; qualityOptions: string[]; maxCount: number }, input: { size: string; quality?: string; count: number }): string | null {
  if (!model.sizes.includes(input.size)) return 'INVALID_SIZE'
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > model.maxCount) return 'INVALID_COUNT'
  if (model.adapter === 'openai' && (!input.quality || !model.qualityOptions.includes(input.quality))) return 'INVALID_QUALITY'
  if (model.adapter === 'seedream' && input.quality) return 'INVALID_QUALITY'
  return null
}
