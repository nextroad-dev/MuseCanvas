import type { ApiResponse } from '@/shared/types'

/** Adopt the server's persisted DTO only when the current-draft test was verified. */
export function requireVerifiedAdminSettings<T>(response: ApiResponse<{ verified: boolean; settings: T }>, fallback: string): T {
  if (!response.success || !response.data?.verified || !response.data.settings) {
    throw new Error(response.error?.message || fallback)
  }
  return response.data.settings
}

/** Undefined fields mean keep the stored value; write-only nonempty secrets count as changes. */
export function adminSettingsDraftChanged(input: object, baseline: object): boolean {
  const stored = baseline as Record<string, unknown>
  return Object.entries(input).some(([key, value]) => value !== undefined && value !== stored[key])
}

/** Older cache data after our own save is not an external update. */
export function hasNewerAdminSettingsRevision(loaded: { revision: number }, latest: { revision: number }): boolean {
  return latest.revision > loaded.revision
}

export function resolveAdminConcurrency(raw: string): { value: number; error?: never } | { value?: never; error: string } {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 50) {
    return { error: '请输入 1–50 之间的有限整数，不能为空或包含小数。' }
  }
  return { value }
}
