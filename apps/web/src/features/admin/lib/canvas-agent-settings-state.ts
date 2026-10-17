import type { CanvasAgentSettingsDto, UpdateCanvasAgentSettingsRequest } from '@musecanvas/contracts'

/**
 * Numeric bounds enforced by the server: `parseUpdateCanvasAgentSettingsRequest`
 * (packages/contracts/src/canvas.ts) and the `canvas_agent_settings` CHECK
 * constraints (packages/database/migrations/0031_canvas_agent.sql). Kept as data
 * so the form inputs, the client-side validation and this module's tests cannot
 * disagree; the API's own tests reject the same out-of-range values.
 */
export const CANVAS_AGENT_SETTING_LIMITS = {
  maxToolCallsPerTurn: { min: 1, max: 32 },
  maxJobsPerTurn: { min: 1, max: 8 },
  timeoutMs: { min: 1_000, max: 300_000 },
  maxAutoContinuations: { min: 0, max: 10 },
} as const

export type CanvasAgentNumericField = keyof typeof CANVAS_AGENT_SETTING_LIMITS

export const CANVAS_AGENT_NUMERIC_FIELDS = [
  'maxToolCallsPerTurn',
  'maxJobsPerTurn',
  'timeoutMs',
  'maxAutoContinuations',
] as const satisfies readonly CanvasAgentNumericField[]

/** Text drafts: numbers stay strings so an empty/malformed input is visible. */
export interface CanvasAgentSettingsDraft {
  enabled: boolean
  /** Empty string means "no model bound" and serialises to `null`. */
  languageModelConfigId: string
  maxToolCallsPerTurn: string
  maxJobsPerTurn: string
  timeoutMs: string
  maxAutoContinuations: string
}

export type CanvasAgentSettingsErrorField = 'languageModelConfigId' | CanvasAgentNumericField
export type CanvasAgentSettingsErrors = Partial<Record<CanvasAgentSettingsErrorField, string>>

/**
 * Server state -> editable draft. A disabled/`null`-model row stays disabled with
 * no model: the form never invents a selection or enables the feature.
 */
export function canvasAgentSettingsDraft(settings: CanvasAgentSettingsDto): CanvasAgentSettingsDraft {
  return {
    enabled: settings.enabled,
    languageModelConfigId: settings.languageModelConfigId ?? '',
    maxToolCallsPerTurn: String(settings.maxToolCallsPerTurn),
    maxJobsPerTurn: String(settings.maxJobsPerTurn),
    timeoutMs: String(settings.timeoutMs),
    maxAutoContinuations: String(settings.maxAutoContinuations),
  }
}

function parseNumber(draft: CanvasAgentSettingsDraft, field: CanvasAgentNumericField) {
  const raw = draft[field].trim()
  const { min, max } = CANVAS_AGENT_SETTING_LIMITS[field]
  const value = Number(raw)
  if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
    return { error: `请输入 ${min}–${max} 之间的整数。` } as const
  }
  return { value } as const
}

/**
 * Client-side mirror of the server rules the form can know: integer bounds, a
 * model must be selected before enabling, and a bound model must still exist in
 * the loaded catalog. Everything else (credential/protocol support) is left to
 * the server, whose rejection is surfaced verbatim.
 */
export function validateCanvasAgentDraft(
  draft: CanvasAgentSettingsDraft,
  availableModelIds: readonly string[],
): { errors: CanvasAgentSettingsErrors; payload?: UpdateCanvasAgentSettingsRequest; firstError?: string } {
  const errors: CanvasAgentSettingsErrors = {}
  const numbers: Record<CanvasAgentNumericField, number> = {
    maxToolCallsPerTurn: 0,
    maxJobsPerTurn: 0,
    timeoutMs: 0,
    maxAutoContinuations: 0,
  }
  for (const field of CANVAS_AGENT_NUMERIC_FIELDS) {
    const parsed = parseNumber(draft, field)
    if (parsed.error) errors[field] = parsed.error
    else numbers[field] = parsed.value
  }

  const modelId = draft.languageModelConfigId.trim()
  if (modelId && availableModelIds.length > 0 && !availableModelIds.includes(modelId)) {
    errors.languageModelConfigId = '所选语言模型已不在可用列表中，请重新选择。'
  }
  if (draft.enabled && !modelId) {
    errors.languageModelConfigId = '启用 Canvas Agent 前必须选择一个可用的语言模型。'
  }

  const errorFields = Object.keys(errors) as CanvasAgentSettingsErrorField[]
  if (errorFields.length > 0) return { errors, firstError: errors[errorFields[0]!] }

  return {
    errors,
    payload: {
      enabled: draft.enabled,
      languageModelConfigId: modelId || null,
      maxToolCallsPerTurn: numbers.maxToolCallsPerTurn,
      maxJobsPerTurn: numbers.maxJobsPerTurn,
      timeoutMs: numbers.timeoutMs,
      maxAutoContinuations: numbers.maxAutoContinuations,
    },
  }
}

/** A draft differing from the persisted row in any field is dirty; invalid input is always dirty. */
export function canvasAgentDraftChanged(draft: CanvasAgentSettingsDraft, settings: CanvasAgentSettingsDto): boolean {
  if (draft.enabled !== settings.enabled) return true
  if (draft.languageModelConfigId.trim() !== (settings.languageModelConfigId ?? '')) return true
  for (const field of CANVAS_AGENT_NUMERIC_FIELDS) {
    const raw = draft[field].trim()
    if (raw === '' || Number(raw) !== settings[field]) return true
  }
  return false
}

const CANVAS_AGENT_SAVE_ERRORS: Record<string, string> = {
  CANVAS_AGENT_NOT_CONFIGURED:
    '所选语言模型当前不可用：必须是已启用的内置语言模型，且关联凭据已启用并保存了密钥。请先在「语言模型」页处理。',
  CANVAS_AGENT_MODEL_UNSUPPORTED:
    '所选语言模型不受 Canvas Agent 支持（仅支持内置的 openai_chat 或 anthropic_messages 模型）。',
  CANVAS_AGENT_DISABLED: 'Canvas Agent 当前处于停用状态，无法执行该操作。',
  INVALID_INPUT: '提交的设置超出服务端允许范围，请检查各项数值后重试。',
  FORBIDDEN: '仅管理员可以修改 Canvas Agent 设置。',
  CANVAS_AGENT_FAILED: '保存 Canvas Agent 设置失败，服务端未能完成写入，请稍后重试。',
}

/** Server/transport error -> copy that names the actual cause instead of a generic failure. */
export function canvasAgentSaveError(
  error: { code?: string; message?: string } | null | undefined,
  fallback = '保存 Canvas Agent 设置失败',
): string {
  const mapped = error?.code ? CANVAS_AGENT_SAVE_ERRORS[error.code] : undefined
  if (mapped) return mapped
  return error?.message?.trim() || fallback
}

/** Older cache after our own save is not an external update. */
export function hasNewerCanvasAgentSettings(loadedUpdatedAt: string, latestUpdatedAt: string): boolean {
  return latestUpdatedAt > loadedUpdatedAt
}
