import { parseUpdateCanvasAgentSettingsRequest, type CanvasAgentSettingsDto } from '@musecanvas/contracts'
import { transaction, getCanvasAgentSettings, updateCanvasAgentSettings as persistSettings } from '../../../../../packages/database/src/index'
import type { Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { writeAudit } from '../../shared/audit'
import { safeError, validateLanguageConfig } from '../canvases/agent/config'

export function canvasAgentSettingsDto(settings: CanvasAgentSettingsDto): CanvasAgentSettingsDto {
  const { enabled, languageModelConfigId, maxToolCallsPerTurn, maxJobsPerTurn, timeoutMs, maxAutoContinuations, updatedAt } = settings
  return { enabled, languageModelConfigId, maxToolCallsPerTurn, maxJobsPerTurn, timeoutMs, maxAutoContinuations, updatedAt }
}
export async function readCanvasAgentSettings() {
  try { return ok(canvasAgentSettingsDto(await transaction(client => getCanvasAgentSettings(client)))) }
  catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
}
export async function updateCanvasAgentSettings(actor: Actor, input: unknown) {
  if (actor.role !== 'admin') return fail('FORBIDDEN', 'FORBIDDEN', 403)
  const parsed = parseUpdateCanvasAgentSettingsRequest(input)
  if (!parsed.success) return fail(parsed.error.code, 'Invalid settings')
  try {
    const settings = await transaction(async client => {
      await client.query('SELECT singleton FROM canvas_agent_settings WHERE singleton=true FOR UPDATE')
      const next = { ...await getCanvasAgentSettings(client), ...parsed.data }
      if (next.languageModelConfigId || next.enabled) await validateLanguageConfig(client, next.languageModelConfigId)
      const updated = await persistSettings(client, actor.id, parsed.data)
      await writeAudit(client, actor.id, 'canvas_agent_settings.update', 'settings', 'singleton', parsed.data)
      return updated
    })
    return ok(canvasAgentSettingsDto(settings))
  } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
}
