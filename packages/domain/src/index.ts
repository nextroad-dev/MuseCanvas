export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled'
export const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'canceled'])
const qualityOptions = new Set(['auto', 'low', 'medium', 'high'])
const sizeBands = new Set(['2K', '3K', '4K'])

function sizeValid(size: string): boolean {
  if (sizeBands.has(size)) return true
  const match = size.match(/^(\d{3,4})x(\d{3,4})$/)
  if (!match) return false
  const width = Number(match[1])
  const height = Number(match[2])
  return width >= 256 && width <= 4096 && height >= 256 && height <= 4096 && width * height <= 4096 * 4096
}

export function validateModelInput(_model: { adapter: string; sizes: string[]; qualityOptions: string[]; maxCount: number }, input: { size: string; quality?: string; count: number }): string | null {
  if (!sizeValid(input.size)) return 'INVALID_SIZE'
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 4) return 'INVALID_COUNT'
  if (input.quality && !qualityOptions.has(input.quality)) return 'INVALID_QUALITY'
  return null
}
