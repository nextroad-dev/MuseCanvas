import type pg from 'pg'
import { CanvasErrorCode, isCanvasStorageString, type CanvasAgentSettingsDto, type JsonObject } from '@musecanvas/contracts'
import { canvasAgentRequestDigest, findProviderCredential } from '../../../../../../packages/database/src/index'
import { decodeStoredCredential, decryptStoredCredential, hasStoredCredentialSecret, isBuiltinLanguagePluginKey, type LanguageModelChatInput } from '../../../../../../packages/providers/src/index'

export class AgentError extends Error {
  constructor(readonly code: CanvasErrorCode, readonly status = 400) { super(code) }
}
export function raise(code: CanvasErrorCode, status = 400): never { throw new AgentError(code, status) }
/** Provider text/JSON is not covered by request parsers. Reject strings PostgreSQL cannot
 * store before JSON.stringify escapes them or any message transaction is opened. */
export function assertStorageStrings(value: unknown, depth = 0): void {
  if (depth > 100) raise(CanvasErrorCode.CANVAS_AGENT_FAILED, 503)
  if (typeof value === 'string') {
    if (!isCanvasStorageString(value)) raise(CanvasErrorCode.CANVAS_AGENT_FAILED, 503)
  } else if (Array.isArray(value)) {
    for (const item of value) assertStorageStrings(item, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!isCanvasStorageString(key)) raise(CanvasErrorCode.CANVAS_AGENT_FAILED, 503)
      assertStorageStrings(item, depth + 1)
    }
  }
}
export function safeError(error: unknown): AgentError {
  return error instanceof AgentError ? error : new AgentError(CanvasErrorCode.CANVAS_AGENT_FAILED, 503)
}
export function assertLanguageModel(model: Record<string, any> | undefined, credential: Record<string, any> | null): void {
  if (!model || model.model_kind !== 'language' || !model.enabled || model.deleted_at || !credential || !credential.enabled || credential.deleted_at || !hasStoredCredentialSecret(credential)) raise(CanvasErrorCode.CANVAS_AGENT_NOT_CONFIGURED, 409)
  if (!['openai_chat', 'anthropic_messages'].includes(model.language_protocol)
    || !isBuiltinLanguagePluginKey(model.plugin_id, model.plugin_version)
    || model.plugin_id !== (model.language_protocol === 'openai_chat' ? 'openai-language' : 'anthropic-language')
    || (credential.schema_id && credential.schema_id !== 'legacy-api-key-v1')
    || (model.language_protocol === 'anthropic_messages' && model.reasoning_effort && model.reasoning_effort !== 'none')) raise(CanvasErrorCode.CANVAS_AGENT_MODEL_UNSUPPORTED, 409)
}
export async function validateLanguageConfig(client: pg.PoolClient, modelId: string | null) {
  if (!modelId) raise(CanvasErrorCode.CANVAS_AGENT_NOT_CONFIGURED, 409)
  const model = (await client.query('SELECT * FROM model_configs WHERE id=$1', [modelId])).rows[0]
  const credential = model?.provider_credential_id ? await findProviderCredential(client, model.provider_credential_id) : null
  assertLanguageModel(model, credential)
  return { model: model!, credential: credential! }
}
export async function runtimeConfig(client: pg.PoolClient, settings: CanvasAgentSettingsDto): Promise<Omit<LanguageModelChatInput, 'system' | 'messages' | 'tools' | 'signal'>> {
  if (!settings.enabled) raise(CanvasErrorCode.CANVAS_AGENT_DISABLED, 409)
  const { model, credential } = await validateLanguageConfig(client, settings.languageModelConfigId)
  try {
    const decoded = decodeStoredCredential(credential, decryptStoredCredential(credential))
    return { protocol: model.language_protocol, vendorModelId: model.vendor_model_id, baseUrl: credential.base_url || model.base_url || undefined,
      credential: decoded, pluginId: model.plugin_id, pluginVersion: model.plugin_version, maxOutputTokens: model.max_output_tokens,
      temperature: model.temperature == null ? undefined : Number(model.temperature), reasoningEffort: model.reasoning_effort, timeoutMs: settings.timeoutMs }
  } catch { return raise(CanvasErrorCode.CANVAS_AGENT_NOT_CONFIGURED, 409) }
}
/** Only safe configuration identity is hashed. No ciphertext, decoded secret or provider URL. */
export function modelConfigDigest(model: Record<string, any>, credential: Record<string, any> | null): string {
  const stamp = (value: unknown) => value instanceof Date ? value.toISOString() : value ?? null
  return canvasAgentRequestDigest({ id: model.id, revisionId: model.latest_revision_id ?? null, capabilities: model.capabilities ?? null,
    defaults: model.defaults ?? null, vendorModelId: model.vendor_model_id, pluginId: model.plugin_id ?? null, pluginVersion: model.plugin_version ?? null,
    providerId: model.provider_id ?? null, credentialId: model.provider_credential_id ?? null, updatedAt: stamp(model.updated_at),
    credentialUpdatedAt: stamp(credential?.updated_at), credentialSchema: credential?.schema_id ?? null } as JsonObject)
}
