import { createHash } from 'node:crypto'
import { db } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { providerCredentialDto } from '../../shared/dto'
import { normalizedProviderBaseUrl } from '../../shared/model-helpers'
import { callLanguageModel } from '../../../../../packages/providers/src/index'
import { decryptApiKey, encryptApiKey, fingerprintApiKey } from '../../auth/security'

const LEGACY_ADAPTERS = ['openai', 'seedream', 'anthropic'] as const

function extractSecret(input: Record<string, unknown>): { apiKey?: string; payloadObject?: Record<string, unknown> } {
  const credential = input.credential
  if (typeof credential === 'string' && credential.trim()) {
    const trimmed = credential.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        return { payloadObject: parsed }
      } catch {
        return { apiKey: trimmed }
      }
    }
    return { apiKey: trimmed }
  }
  if (credential && typeof credential === 'object' && !Array.isArray(credential)) {
    return { payloadObject: credential as Record<string, unknown> }
  }
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    return { apiKey: input.apiKey.trim() }
  }
  return {}
}

function secretFingerprint(secret: { apiKey?: string; payloadObject?: Record<string, unknown> }): string | null {
  try {
    if (secret.apiKey) return fingerprintApiKey(secret.apiKey)
    if (secret.payloadObject) {
      const apiKey = secret.payloadObject.apiKey ?? secret.payloadObject.key
      if (typeof apiKey === 'string' && apiKey.trim()) return fingerprintApiKey(apiKey.trim())
      return createHash('sha256').update(JSON.stringify(secret.payloadObject)).digest('hex').slice(0, 8)
    }
  } catch {
    return null
  }
  return null
}

function secretPayload(secret: { apiKey?: string; payloadObject?: Record<string, unknown> }): string {
  if (secret.apiKey) return secret.apiKey
  return JSON.stringify(secret.payloadObject)
}

function secretHasApiKey(secret: { apiKey?: string; payloadObject?: Record<string, unknown> }): boolean {
  if (secret.apiKey) return true
  if (secret.payloadObject) {
    return typeof secret.payloadObject.apiKey === 'string' || typeof secret.payloadObject.key === 'string'
  }
  return false
}


export async function createProviderCredential(actor: Actor, input: Record<string, unknown>) {
  // New plugin/provider identity fields; legacy adapter remains accepted.
  const providerId = typeof input.providerId === 'string' && input.providerId.trim()
    ? input.providerId.trim()
    : typeof input.adapter === 'string' && (LEGACY_ADAPTERS as readonly string[]).includes(input.adapter)
      ? input.adapter === 'seedream' ? 'volcengine' : input.adapter
      : null
  const adapter = typeof input.adapter === 'string' && (LEGACY_ADAPTERS as readonly string[]).includes(input.adapter)
    ? input.adapter
    : providerId === 'openai' ? 'openai' : providerId === 'anthropic' ? 'anthropic' : providerId === 'volcengine' ? 'seedream' : null
  if (!providerId) return fail('INVALID_INPUT', '供应商类型无效')
  if (typeof input.displayName !== 'string' || !input.displayName.trim())
    return fail('INVALID_INPUT', '凭据名称不能为空')
  const schemaId = typeof input.schemaId === 'string' && input.schemaId.trim() ? input.schemaId.trim() : 'legacy-api-key-v1'
  const schemaVersion = input.schemaVersion !== undefined ? Number(input.schemaVersion) : 1
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) return fail('INVALID_INPUT', '凭据 schema 版本无效')
  const explicitBaseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (explicitBaseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const secret = extractSecret(input)
  const hasSecret = Boolean(secret.apiKey || secret.payloadObject)
  if (!hasSecret) return fail('INVALID_INPUT', '凭据内容不能为空（credential 或 apiKey）')
  const payloadSecretBaseUrl = secret.payloadObject && typeof secret.payloadObject.baseUrl === 'string'
    ? normalizedProviderBaseUrl(secret.payloadObject.baseUrl)
    : undefined
  if (payloadSecretBaseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const effectiveBaseUrl = explicitBaseUrl || payloadSecretBaseUrl || undefined
  const payload = secretPayload(secret)
  let encrypted: string
  try {
    encrypted = encryptApiKey(payload)
  } catch {
    return fail('CREDENTIAL_ENCRYPT_FAILED', '凭据加密失败，请检查加密配置', 500)
  }
  const fingerprint = secretFingerprint(secret)
  const configuredFields = {
    hasApiKey: secretHasApiKey(secret),
    apiKeyFingerprint: fingerprint,
    baseUrl: effectiveBaseUrl || null,
    legacyFormat: !secret.payloadObject,
    ...(typeof input.pluginId === 'string' && input.pluginId.trim() ? { pluginId: input.pluginId.trim() } : {}),
  }
  const enabled = input.enabled === true
  const r = await db().query(
    `INSERT INTO provider_credentials(display_name,adapter,base_url,api_key_encrypted,api_key_fingerprint,enabled,created_by,updated_by,
      provider_id,schema_id,schema_version,payload_encrypted,configured_fields)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [input.displayName.trim(), adapter, effectiveBaseUrl || null,
      secret.apiKey ? encrypted : (secretHasApiKey(secret) ? encrypted : null),
      fingerprint, enabled, actor.id,
      providerId, schemaId, schemaVersion, encrypted, JSON.stringify(configuredFields)],
  )
  return ok(providerCredentialDto(r.rows[0]))
}

export async function updateProviderCredential(
  actor: Actor,
  id: string,
  input: Record<string, unknown>,
) {
  const existing = await db().query(
    'SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  if (!existing.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  const current = existing.rows[0]
  const baseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const secret = extractSecret(input)
  const hasNewSecret = Boolean(secret.apiKey || secret.payloadObject)
  let encrypted: string | null = null
  let fingerprint: string | null = null
  let legacyEncrypted: string | null = null
  if (hasNewSecret) {
    const payload = secretPayload(secret)
    try {
      encrypted = encryptApiKey(payload)
    } catch {
      return fail('CREDENTIAL_ENCRYPT_FAILED', '凭据加密失败，请检查加密配置', 500)
    }
    fingerprint = secretFingerprint(secret)
    legacyEncrypted = secret.apiKey ? encrypted : (secretHasApiKey(secret) ? encrypted : null)
  }
  const payloadSecretBaseUrl = secret.payloadObject && typeof secret.payloadObject.baseUrl === 'string'
    ? normalizedProviderBaseUrl(secret.payloadObject.baseUrl)
    : undefined
  if (payloadSecretBaseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const effectiveBaseUrl = baseUrl !== undefined ? baseUrl || null : payloadSecretBaseUrl || undefined
  const providerId = typeof input.providerId === 'string' && input.providerId.trim()
    ? input.providerId.trim()
    : undefined
  const schemaId = typeof input.schemaId === 'string' && input.schemaId.trim() ? input.schemaId.trim() : undefined
  const schemaVersion = input.schemaVersion !== undefined ? Number(input.schemaVersion) : undefined
  if (schemaVersion !== undefined && (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
    return fail('INVALID_INPUT', '凭据 schema 版本无效')
  }
  const currentConfigured = ((): Record<string, unknown> => {
    try {
      return typeof current.configured_fields === 'object' && current.configured_fields !== null
        ? current.configured_fields as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  })()
  const nextConfigured = hasNewSecret
    ? {
      ...currentConfigured,
      hasApiKey: secretHasApiKey(secret),
      apiKeyFingerprint: fingerprint,
      baseUrl: (effectiveBaseUrl !== undefined ? effectiveBaseUrl : current.base_url) || null,
      legacyFormat: !secret.payloadObject,
    }
    : currentConfigured
  const r = await db().query(
    `UPDATE provider_credentials SET display_name=COALESCE($1,display_name),base_url=CASE WHEN $2::text IS NULL AND $9::boolean THEN base_url ELSE COALESCE($2,base_url) END,
      api_key_encrypted=CASE WHEN $3::boolean THEN $4 ELSE api_key_encrypted END,
      api_key_fingerprint=CASE WHEN $3::boolean THEN $5 ELSE api_key_fingerprint END,
      payload_encrypted=CASE WHEN $3::boolean THEN $6 ELSE payload_encrypted END,
      provider_id=COALESCE($7,provider_id),schema_id=COALESCE($8,schema_id),schema_version=COALESCE($10,schema_version),
      configured_fields=$11::jsonb,enabled=COALESCE($12,enabled),updated_at=now(),updated_by=$13
     WHERE id=$14 AND deleted_at IS NULL RETURNING *`,
    [
      typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null,
      effectiveBaseUrl === undefined ? null : effectiveBaseUrl,
      hasNewSecret,
      legacyEncrypted,
      fingerprint,
      encrypted,
      providerId || null,
      schemaId || null,
      effectiveBaseUrl === undefined,
      schemaVersion ?? null,
      JSON.stringify(nextConfigured),
      typeof input.enabled === 'boolean' ? input.enabled : null,
      actor.id,
      id,
    ],
  )
  if (!r.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  return ok(providerCredentialDto(r.rows[0]))
}

export async function deleteProviderCredential(id: string) {
  const inUse = await db().query(
    'SELECT id FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )
  if (inUse.rows[0]) return fail('CREDENTIAL_IN_USE', '该凭据仍被模型使用，无法删除', 409)
  const r = await db().query(
    'UPDATE provider_credentials SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
    [id],
  )
  return r.rows[0] ? ok({ deleted: true }) : fail('NOT_FOUND', '供应商凭据不存在', 404)
}

function decryptCredentialPayload(row: Record<string, unknown>): string {
  const payload = row.payload_encrypted as string | undefined
  if (payload) return decryptApiKey(payload)
  const legacy = row.api_key_encrypted as string | undefined
  if (legacy) return decryptApiKey(legacy)
  throw new Error('PROVIDER_NOT_CONFIGURED')
}

export async function testProviderCredential(id: string) {
  const cred = await db().query(
    'SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  if (!cred.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  const row = cred.rows[0]
  let rawSecret: string
  try {
    rawSecret = decryptCredentialPayload(row)
  } catch {
    await db().query(
      "UPDATE provider_credentials SET last_test_status='failed',last_test_error_code='NO_API_KEY',last_tested_at=now() WHERE id=$1",
      [id],
    )
    return fail('INVALID_INPUT', '未配置凭据内容，无法测试')
  }
  const providerId = (row.provider_id as string) || (row.adapter as string) || 'legacy'
  if (row.adapter === 'anthropic' || providerId === 'anthropic') {
    const model = await db().query(
      "SELECT id FROM model_configs WHERE provider_credential_id=$1 AND model_kind='language' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      [id],
    )
    return model.rows[0]
      ? testLanguageModel(model.rows[0].id)
      : fail('PROMPT_MODEL_NOT_CONFIGURED', '请先将该凭据关联到语言模型')
  }
  // Media credential test goes through the provider plugin probe — never a
  // direct provider call from the API layer.
  try {
    const providers = (await import('../../../../../packages/providers/src/index')) as unknown as {
      globalProviderRegistry: {
        has: (id: string, version: string) => boolean
        get: (id: string, version: string) => {
          manifest: { credentialSchemas?: string[] }
          probe?: (config: unknown, context: unknown) => Promise<{ healthy: boolean; message?: string }>
          validateConfig: (config: unknown) => void | Promise<void>
        }
        createExecutionContext: (id: string, version: string) => unknown
      }
      decodeCredential: (raw: unknown, schemaHint?: string, pluginId?: string, version?: string) => { apiKey?: string; baseUrl?: string; schema: string }
    }
    const linked = await db().query(
      'SELECT plugin_id,plugin_version,vendor_model_id,base_url FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1',
      [id],
    )
    const pluginId = (linked.rows[0]?.plugin_id as string)
      || (providerId === 'openai' ? 'openai-image' : providerId === 'volcengine' ? 'seedream-image' : providerId === 'google' ? 'veo-video' : null)
    const pluginVersion = (linked.rows[0]?.plugin_version as string) || '1.0.0'
    if (!pluginId || !providers.globalProviderRegistry.has(pluginId, pluginVersion)) {
      await db().query(
        'UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3',
        ['failed', 'PLUGIN_NOT_REGISTERED', id],
      )
      return fail('PLUGIN_NOT_REGISTERED', '该凭据对应的供应商插件尚未可用，请稍后重试')
    }
    const plugin = providers.globalProviderRegistry.get(pluginId, pluginVersion)
    const schemaHint = (row.schema_id as string) || 'legacy-api-key-v1'
    const decoded = providers.decodeCredential(rawSecret, schemaHint, pluginId, pluginVersion)
    const baseUrl = (row.base_url as string) || decoded.baseUrl || (linked.rows[0]?.base_url as string) || undefined
    const config = { baseUrl, credential: decoded, timeoutMs: 15000 }
    await plugin.validateConfig(config)
    if (plugin.probe) {
      const context = providers.globalProviderRegistry.createExecutionContext(pluginId, pluginVersion)
      const started = Date.now()
      const result = await plugin.probe(config, context)
      void started
      if (!result.healthy) throw new Error('PROVIDER_REJECTED')
    }
    await db().query(
      "UPDATE provider_credentials SET last_test_status='success',last_test_error_code=NULL,last_tested_at=now() WHERE id=$1",
      [id],
    )
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONNECTIVITY_FAILED'
    const code = message === 'PLUGIN_NOT_REGISTERED'
      ? 'PLUGIN_NOT_REGISTERED'
      : message.startsWith('HTTP_')
        ? message === 'HTTP_429' || Number(message.slice(5)) >= 500
          ? 'PROVIDER_TEMPORARY_ERROR'
          : 'PROVIDER_REJECTED'
        : ['PROVIDER_REJECTED', 'PROVIDER_TEMPORARY_ERROR', 'PROVIDER_EMPTY_RESULT', 'INVALID_CREDENTIAL'].includes(message)
          ? message
          : 'CONNECTIVITY_FAILED'
    await db().query(
      'UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3',
      ['failed', code, id],
    )
    return fail(
      code,
      code === 'PROVIDER_REJECTED'
        ? '凭据已连接到供应商，但被拒绝访问，请检查模型授权或凭据权限'
        : code === 'PROVIDER_TEMPORARY_ERROR'
          ? '供应商暂时不可用，请稍后重试'
          : code === 'PROVIDER_EMPTY_RESULT'
            ? '供应商没有返回可用结果'
            : code === 'PLUGIN_NOT_REGISTERED'
              ? '该凭据对应的供应商插件尚未可用，请稍后重试'
              : '凭据测试失败，请检查凭据内容和 Base URL',
    )
  }
}

async function testLanguageModel(id: string) {
  const r = await db().query(
    `SELECT m.*,COALESCE(NULLIF(pc.payload_encrypted,''),pc.api_key_encrypted) effective_encrypted,COALESCE(pc.base_url,m.base_url) effective_base_url FROM model_configs m JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.id=$1 AND m.model_kind='language' AND m.deleted_at IS NULL AND pc.enabled=true`,
    [id],
  )
  const model = r.rows[0]
  if (!model?.effective_encrypted)
    return fail('PROMPT_MODEL_NOT_CONFIGURED', '语言模型或凭据未正确配置')
  try {
    const reasoningEffort =
      ['gpt-5.4', 'gpt-5.5'].includes(model.vendor_model_id) ? 'none' : model.reasoning_effort || undefined
    await callLanguageModel({
      protocol: model.language_protocol,
      vendorModelId: model.vendor_model_id,
      baseUrl: model.effective_base_url,
      apiKey: decryptApiKey(model.effective_encrypted),
      system: 'Return only the requested JSON.',
      user: 'MuseCanvas language model connectivity test. Return {"ok":"yes"}.',
      schemaName: 'connectivity_test',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'string', const: 'yes' } },
        required: ['ok'],
      },
      maxOutputTokens: Math.min(1000, model.max_output_tokens),
      reasoningEffort,
      timeoutMs: 15000,
    })
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR'
    return fail(code, '语言模型连通性测试失败', 502)
  }
}
