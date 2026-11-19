import { isUuid } from '@musecanvas/contracts'

/**
 * Runtime-provisioned default Agent for this instance. The studio layout is
 * force-dynamic, so this is resolved per request and never inlined into the
 * client bundle: one web image can serve deployments with different definitions.
 */
export function defaultAgentDefinition(): { agentDefinitionId: string; definitionVersion: number } | null {
  const id = process.env.AGENT_DEFAULT_DEFINITION_ID?.trim().toLowerCase() ?? ''
  if (!isUuid(id)) return null
  const version = Number(process.env.AGENT_DEFAULT_DEFINITION_VERSION ?? '1')
  return {
    agentDefinitionId: id,
    definitionVersion: Number.isSafeInteger(version) && version >= 1 ? version : 1,
  }
}
