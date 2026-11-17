import { AgentCoreError, AgentCoreRepository, db, type AgentCoreTransaction, type AgentDefinitionValidator } from '@musecanvas/database'
import { isBuiltinLanguagePluginKey } from '@musecanvas/providers'
import { definitionBudget, modelPolicy, storageString } from './validation'

/** Safe metadata only; this is not a complete executable Provider request. Runner must recheck credentials. */
export const validateAgentDefinition: AgentDefinitionValidator = async (client, definition) => {
  try {
    const p = modelPolicy(definition.model_policy)
    const { timeoutMs, ...budget } = definitionBudget(definition.budget_policy)
    const instructions = storageString(definition.instructions, 16000)
    if (!Array.isArray(definition.tool_allowlist) || definition.tool_allowlist.length > 32
      || definition.tool_allowlist.some((x: unknown) => typeof x !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}@v[1-9][0-9]{0,3}$/.test(x))) throw new AgentCoreError('UNAVAILABLE')
    const model = (await client.query(`SELECT m.id,m.language_protocol,m.plugin_id,m.plugin_version,m.plugin_source,
      m.vendor_model_id,m.max_output_tokens,m.temperature,m.reasoning_effort,m.latest_revision_id,
      r.id AS revision_id,r.revision,r.provider_id,r.plugin_id AS revision_plugin_id,r.plugin_version AS revision_plugin_version,
      r.vendor_model_id AS revision_vendor_model_id
      FROM model_configs m JOIN model_config_revisions r ON r.id=$2 AND r.model_id=m.id
      WHERE m.id=$1 AND m.model_kind='language' AND m.enabled=true AND m.deleted_at IS NULL FOR SHARE OF m,r`, [p.modelConfigId, p.modelRevisionId])).rows[0]
    if (!model || !['openai_chat', 'anthropic_messages'].includes(model.language_protocol)
      || !isBuiltinLanguagePluginKey(model.plugin_id, model.plugin_version) || model.plugin_source !== 'builtin'
      || model.plugin_id !== (model.language_protocol === 'openai_chat' ? 'openai-language' : 'anthropic-language')
      || model.latest_revision_id !== p.modelRevisionId || model.plugin_id !== model.revision_plugin_id
      || model.plugin_version !== model.revision_plugin_version || model.vendor_model_id !== model.revision_vendor_model_id
      || (model.language_protocol === 'anthropic_messages' && model.reasoning_effort && model.reasoning_effort !== 'none')) throw new AgentCoreError('UNAVAILABLE')
    // Identity strings are identifiers, never arbitrary URLs or JSON that could hide credentials.
    for (const value of [model.vendor_model_id, model.provider_id]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value) || value.includes('://')) throw new AgentCoreError('UNAVAILABLE')
    }
    if (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1 || model.max_output_tokens > 10000000) throw new AgentCoreError('UNAVAILABLE')
    const temperature = model.temperature == null ? null : Number(model.temperature)
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new AgentCoreError('UNAVAILABLE')
    return { config: { definitionId: definition.id, definitionVersion: definition.version, instructions,
      toolAllowlist: definition.tool_allowlist, modelConfigId: model.id, modelRevisionId: model.revision_id, modelRevision: model.revision,
      providerId: model.provider_id, pluginId: model.plugin_id, pluginVersion: model.plugin_version, protocol: model.language_protocol,
      vendorModelId: model.vendor_model_id, maxOutputTokens: model.max_output_tokens, temperature, reasoningEffort: model.reasoning_effort ?? null }, budget, timeoutMs }
  } catch { throw new AgentCoreError('UNAVAILABLE') }
}

export const agentCoreTransaction: AgentCoreTransaction = async (work, readOnly = false) => {
  const client = await db().connect()
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
export type AgentControlPort = Pick<AgentCoreRepository, 'createSession' | 'listSessions' | 'snapshot' | 'items' | 'events' | 'message' | 'steer' | 'getTurn' | 'cancel' | 'resolveApproval'>
export const agentControlPort: AgentControlPort = new AgentCoreRepository(agentCoreTransaction, validateAgentDefinition)
