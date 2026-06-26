export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled'
export const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'canceled'])
const qualityOptions = new Set(['auto', 'low', 'medium', 'high'])
const sizeBands = new Set(['2K', '3K', '4K'])
const SEEDREAM_MAX_ASPECT_RATIO = 16
const seedreamRules = {
  '4.0': { minPixels: 1280 * 720, maxPixels: 4096 * 4096 },
  '4.5': { minPixels: 2560 * 1440, maxPixels: 4096 * 4096 },
  '5.0-lite': { minPixels: 2560 * 1440, maxPixels: 10_404_496 },
}

function seedreamRule(vendorModelId?: string) {
  const id = (vendorModelId || '').toLowerCase()
  if ((id.includes('5-0') || id.includes('5.0')) && id.includes('lite')) return seedreamRules['5.0-lite']
  if (id.includes('4-5') || id.includes('4.5')) return seedreamRules['4.5']
  return seedreamRules['4.0']
}

function exactDimensions(size: string): { width: number; height: number } | null {
  const match = size.match(/^([1-9]\d*)x([1-9]\d*)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { width, height } : null
}

function seedreamSizeValid(size: string, vendorModelId?: string): boolean {
  const dimensions = exactDimensions(size)
  if (!dimensions) return false
  const { width, height } = dimensions
  const pixels = width * height
  const aspectRatio = Math.max(width / height, height / width)
  const rule = seedreamRule(vendorModelId)
  return pixels >= rule.minPixels && pixels <= rule.maxPixels && aspectRatio <= SEEDREAM_MAX_ASPECT_RATIO
}

function sizeValid(model: { adapter: string; vendorModelId?: string }, size: string): boolean {
  if (model.adapter === 'seedream') return seedreamSizeValid(size, model.vendorModelId)
  if (sizeBands.has(size)) return true
  const dimensions = exactDimensions(size)
  if (!dimensions) return false
  const { width, height } = dimensions
  return width >= 256 && width <= 4096 && height >= 256 && height <= 4096 && width * height <= 4096 * 4096
}

export function validateModelInput(model: { adapter: string; vendorModelId?: string; sizes: string[]; qualityOptions: string[]; maxCount: number }, input: { size: string; quality?: string; count: number }): string | null {
  if (!sizeValid(model, input.size)) return 'INVALID_SIZE'
  const maxCount = Math.min(4, Math.max(1, model.maxCount || 1))
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > maxCount) return 'INVALID_COUNT'
  if (input.quality && !qualityOptions.has(input.quality)) return 'INVALID_QUALITY'
  return null
}
