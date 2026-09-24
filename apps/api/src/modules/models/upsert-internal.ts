export function modelOverrideError(input: Record<string, unknown>): 'capabilities' | 'defaults' | null {
  if (!isEmptyInputOverride(input.capabilities)) return 'capabilities'
  if (!isEmptyInputOverride(input.defaults)) return 'defaults'
  return null
}

function isEmptyInputOverride(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

const FORBIDDEN_MANUAL_MODEL_FIELDS = [
  'displayName', 'adapter', 'vendorModelId', 'baseUrl', 'sizes', 'qualityOptions', 'maxCount',
  'modelKind', 'languageProtocol', 'maxOutputTokens', 'temperature', 'maxInputImages',
  'providerId', 'pluginId', 'pluginVersion', 'capabilities', 'defaults',
]

export function hasForbiddenManualModelFields(input: Record<string, unknown>): boolean {
  return FORBIDDEN_MANUAL_MODEL_FIELDS.some((field) => input[field] !== undefined)
}

export function modelSavePath(input: Record<string, unknown>): 'plugin' | 'preset' {
  return typeof input.pluginId === 'string' && input.pluginId.trim() ? 'plugin' : 'preset'
}

export async function presetRevisionOrRow<T>(row: T, snapshot: () => Promise<T>): Promise<T> {
  try {
    return await snapshot()
  } catch {
    return row
  }
}
