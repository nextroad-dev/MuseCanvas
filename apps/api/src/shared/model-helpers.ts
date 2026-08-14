import { modelPresets, type ModelPreset, type ReasoningEffort } from '../admin/model-presets'

export const reasoningEfforts: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']

export function normalizedProviderBaseUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value)
    const insecureAllowed = process.env.ALLOW_INSECURE_PROVIDER_BASE_URL === 'true'
    if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) return null
    if (url.username || url.password || url.search || url.hash) return null
    const host = url.hostname.toLowerCase()
    const privateHost =
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    if (privateHost && process.env.ALLOW_PRIVATE_PROVIDER_BASE_URL !== 'true') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function presetById(value: unknown): ModelPreset | null {
  if (typeof value !== 'string') return null
  return modelPresets.find((preset) => preset.id === value) || null
}

export function sanitizeReasoningEffort(
  value: unknown,
  fallback?: string | null,
): ReasoningEffort | null | undefined {
  if (value === undefined)
    return fallback && reasoningEfforts.includes(fallback as ReasoningEffort)
      ? (fallback as ReasoningEffort)
      : undefined
  if (value === null || value === '') return null
  return typeof value === 'string' && reasoningEfforts.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined
}