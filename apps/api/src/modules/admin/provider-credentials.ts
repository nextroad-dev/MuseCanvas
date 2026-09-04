import { createHash } from 'node:crypto'
import { db } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { providerCredentialDto } from '../../shared/dto'
import { normalizedProviderBaseUrl } from '../../shared/model-helpers'
import { builtinProviderTemplateForPlugin } from '../../admin/provider-templates'
import { callLanguageModel, decodeCredential, globalProviderRegistry } from '../../../../../packages/providers/src/index'
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


// Positive safe-integer schema versions. Shared by create (default 1) and
// update (undefined when untouched) so both paths reject the same bad input.
export function normalizeCredentialSchemaVersion(
  value: unknown,
  defaultVersion?: number,
): { ok: true; version: number | undefined } | { ok: false } {
  if (value === undefined) {
    return defaultVersion === undefined
      ? { ok: true, version: undefined }
      : { ok: true, version: defaultVersion }
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return { ok: false }
  return { ok: true, version: parsed }
}

// Detects whether an update redirects the credential target (host or plugin
// identity). A null/empty base URL counts as unset on both sides.
export function credentialTargetChanged(
  current: { baseUrl?: unknown; pluginId?: unknown; pluginVersion?: unknown },
  next: { baseUrl?: unknown; pluginId?: unknown; pluginVersion?: unknown },
): boolean {
  const host = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    try {
      return new URL(value).hostname.toLowerCase()
    } catch {
      return value
    }
  }
  const identity = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null
  return (
    host(next.baseUrl) !== host(current.baseUrl) ||
    identity(next.pluginId) !== identity(current.pluginId) ||
    identity(next.pluginVersion) !== identity(current.pluginVersion)
  )
}

export type ExplicitPluginCredentialResult =
  | {
    ok: true
    pluginId: string
    pluginVersion: string
    schemaId: string
    schemaVersion: number
    baseUrl: string | undefined
  }
  | { ok: false; code: string; message: string }

// Validates an explicit plugin identity for credential create/update. The
// plugin must be registered, the schema must be one of its declared
// credential schemas, and a supplied secret is decoded and validated with
// the plugin before it may be encrypted. Built-in templates additionally pin
// the catalog providerId/baseUrl metadata (defaulting an absent base URL).
// Callers without an explicit plugin identity keep the legacy custom and
// language credential behavior and must not route through here.
export async function validateExplicitPluginCredential(options: {
  pluginId: string
  pluginVersion: string
  schemaId?: unknown
  schemaVersion?: unknown
  providerId?: unknown
  baseUrl?: string | null
  secretPayload?: unknown
}): Promise<ExplicitPluginCredentialResult> {
  const { pluginId, pluginVersion } = options
  if (!globalProviderRegistry.has(pluginId, pluginVersion)) {
    return { ok: false, code: 'INVALID_PLUGIN', message: '供应商插件不存在或版本不受支持' }
  }
  const plugin = globalProviderRegistry.get(pluginId, pluginVersion)
  const template = builtinProviderTemplateForPlugin(pluginId, pluginVersion)
  const schemaId =
    typeof options.schemaId === 'string' && options.schemaId.trim()
      ? options.schemaId.trim()
      : (template?.credential.schemaId ?? 'legacy-api-key-v1')
  if (!(plugin.manifest.credentialSchemas ?? []).includes(schemaId)) {
    return { ok: false, code: 'INVALID_INPUT', message: '该插件不支持此凭据 schema' }
  }
  const parsedVersion = normalizeCredentialSchemaVersion(
    options.schemaVersion,
    template?.credential.schemaVersion ?? 1,
  )
  if (!parsedVersion.ok || parsedVersion.version === undefined) {
    return { ok: false, code: 'INVALID_INPUT', message: '凭据 schema 版本无效' }
  }
  const provider =
    typeof options.providerId === 'string' && options.providerId.trim()
      ? options.providerId.trim()
      : (template?.providerId ?? '')
  if (template && provider !== template.providerId) {
    return { ok: false, code: 'INVALID_INPUT', message: `该插件凭据的供应商类型必须为 ${template.providerId}` }
  }
  let baseUrl = options.baseUrl ?? undefined
  if (template) {
    if (baseUrl && baseUrl !== template.baseUrl) {
      return { ok: false, code: 'INVALID_BASE_URL', message: '该插件凭据的 Base URL 与内置模板不一致' }
    }
    if (!baseUrl) baseUrl = template.baseUrl
  }
  if (options.secretPayload !== undefined) {
    const raw = options.secretPayload
    if (typeof raw === 'string' && !raw.trim()) {
      return { ok: false, code: 'INVALID_CREDENTIAL', message: '凭据内容不能为空' }
    }
    let decoded: { apiKey?: string; baseUrl?: string; schema: string; extra?: Record<string, unknown> }
    try {
      decoded = decodeCredential(raw, schemaId, pluginId, pluginVersion)
    } catch (error) {
      return { ok: false, code: 'INVALID_CREDENTIAL', message: error instanceof Error ? error.message : '凭据内容无法解析' }
    }
    if (pluginId === 'veo-video') {
      const extra = decoded.extra ?? {}
      const accessToken =
        (decoded.schema === 'access-token-v1' ? decoded.apiKey : undefined) ??
        (typeof extra.accessToken === 'string' && extra.accessToken ? extra.accessToken : undefined)
      const clientEmail = typeof extra.client_email === 'string' ? extra.client_email.trim() : ''
      const privateKey = typeof extra.private_key === 'string' ? extra.private_key.trim() : ''
      if (!accessToken && (!clientEmail || !privateKey)) {
        return { ok: false, code: 'INVALID_CREDENTIAL', message: 'Veo 服务账号凭据缺少 client_email/private_key' }
      }
    }
    try {
      await plugin.validateConfig({ baseUrl, credential: decoded })
    } catch (error) {
      return { ok: false, code: 'INVALID_CREDENTIAL', message: error instanceof Error ? error.message : '凭据未通过插件校验' }
    }
  }
  return { ok: true, pluginId, pluginVersion, schemaId, schemaVersion: parsedVersion.version, baseUrl }
}

export async function createProviderCredential(actor: Actor, input: Record<string, unknown>) {
  // New plugin/provider identity fields; legacy adapter remains accepted.
  // Custom and language credentials carry no plugin identity and keep the
  // legacy behavior below; explicit plugin identities route through the
  // registry-backed validator before anything is encrypted.
  const explicitPluginId = typeof input.pluginId === 'string' && input.pluginId.trim() ? input.pluginId.trim() : null
  const explicitPluginVersion = typeof input.pluginVersion === 'string' && input.pluginVersion.trim() ? input.pluginVersion.trim() : null
  if ((explicitPluginId || explicitPluginVersion) && !(explicitPluginId && explicitPluginVersion)) {
    return fail('INVALID_INPUT', '插件身份需要同时提供 pluginId 与 pluginVersion')
  }
  if (explicitPluginId && explicitPluginVersion && !globalProviderRegistry.has(explicitPluginId, explicitPluginVersion)) {
    return fail('INVALID_PLUGIN', '供应商插件不存在或版本不受支持')
  }
  const template = explicitPluginId && explicitPluginVersion
    ? builtinProviderTemplateForPlugin(explicitPluginId, explicitPluginVersion)
    : null
  const providerId = typeof input.providerId === 'string' && input.providerId.trim()
    ? input.providerId.trim()
    : typeof input.adapter === 'string' && (LEGACY_ADAPTERS as readonly string[]).includes(input.adapter)
      ? input.adapter === 'seedream' ? 'volcengine' : input.adapter
      : template?.providerId ?? null
  const adapter = typeof input.adapter === 'string' && (LEGACY_ADAPTERS as readonly string[]).includes(input.adapter)
    ? input.adapter
    : providerId === 'openai' ? 'openai' : providerId === 'anthropic' ? 'anthropic' : providerId === 'volcengine' ? 'seedream' : null
  if (!providerId) return fail('INVALID_INPUT', '供应商类型无效')
  if (typeof input.displayName !== 'string' || !input.displayName.trim())
    return fail('INVALID_INPUT', '凭据名称不能为空')
  const explicitBaseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (explicitBaseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const secret = extractSecret(input)
  const hasSecret = Boolean(secret.apiKey || secret.payloadObject)
  if (!hasSecret) return fail('INVALID_INPUT', '凭据内容不能为空（credential 或 apiKey）')
  const payloadSecretBaseUrl = secret.payloadObject && typeof secret.payloadObject.baseUrl === 'string'
    ? normalizedProviderBaseUrl(secret.payloadObject.baseUrl)
    : undefined
  if (payloadSecretBaseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  const requestedBaseUrl = explicitBaseUrl || payloadSecretBaseUrl || undefined
  // Explicit plugin identities resolve schema/base URL metadata and decode +
  // validate the secret with the plugin before encryption; legacy paths keep
  // the historical defaults untouched.
  let schemaId = typeof input.schemaId === 'string' && input.schemaId.trim() ? input.schemaId.trim() : 'legacy-api-key-v1'
  let schemaVersion: number
  {
    const parsedSchema = normalizeCredentialSchemaVersion(input.schemaVersion, 1)
    if (!parsedSchema.ok || parsedSchema.version === undefined) return fail('INVALID_INPUT', '凭据 schema 版本无效')
    schemaVersion = parsedSchema.version
  }
  let effectiveBaseUrl = requestedBaseUrl
  if (explicitPluginId && explicitPluginVersion) {
    const checked = await validateExplicitPluginCredential({
      pluginId: explicitPluginId,
      pluginVersion: explicitPluginVersion,
      schemaId: input.schemaId,
      schemaVersion: input.schemaVersion,
      providerId,
      baseUrl: requestedBaseUrl,
      secretPayload: secretPayload(secret),
    })
    if (!checked.ok) return fail(checked.code, checked.message)
    schemaId = checked.schemaId
    schemaVersion = checked.schemaVersion
    effectiveBaseUrl = checked.baseUrl
  }
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
    ...(explicitPluginId ? { pluginId: explicitPluginId } : {}),
    ...(explicitPluginVersion ? { pluginVersion: explicitPluginVersion } : {}),
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
  let effectiveBaseUrl = baseUrl !== undefined ? baseUrl || null : payloadSecretBaseUrl || undefined
  const providerId = typeof input.providerId === 'string' && input.providerId.trim()
    ? input.providerId.trim()
    : undefined
  let schemaId = typeof input.schemaId === 'string' && input.schemaId.trim() ? input.schemaId.trim() : undefined
  const parsedUpdateSchema = normalizeCredentialSchemaVersion(input.schemaVersion)
  if (!parsedUpdateSchema.ok) return fail('INVALID_INPUT', '凭据 schema 版本无效')
  let schemaVersion = parsedUpdateSchema.version
  const currentConfigured = ((): Record<string, unknown> => {
    try {
      return typeof current.configured_fields === 'object' && current.configured_fields !== null
        ? current.configured_fields as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  })()
  const nextPluginId = typeof input.pluginId === 'string' && input.pluginId.trim() ? input.pluginId.trim() : undefined
  const nextPluginVersion = typeof input.pluginVersion === 'string' && input.pluginVersion.trim() ? input.pluginVersion.trim() : undefined
  // Explicit plugin identities are registry-validated whenever a new secret
  // is supplied (decode + validate with the plugin before encryption, plus
  // built-in catalog pinning). Metadata-only updates without a new secret
  // never require one, and custom/language credentials without plugin
  // identity keep the legacy behavior untouched.
  {
    const storedPluginId = typeof currentConfigured.pluginId === 'string' && currentConfigured.pluginId.trim()
      ? currentConfigured.pluginId.trim()
      : undefined
    const storedPluginVersion = typeof currentConfigured.pluginVersion === 'string' && currentConfigured.pluginVersion.trim()
      ? currentConfigured.pluginVersion.trim()
      : undefined
    const resultPluginId = nextPluginId ?? storedPluginId
    const resultPluginVersion = nextPluginVersion ?? storedPluginVersion
    if (hasNewSecret && (nextPluginId !== undefined || nextPluginVersion !== undefined || resultPluginId || resultPluginVersion)) {
      if (!resultPluginId || !resultPluginVersion) {
        return fail('INVALID_INPUT', '插件身份需要同时提供 pluginId 与 pluginVersion')
      }
      const checked = await validateExplicitPluginCredential({
        pluginId: resultPluginId,
        pluginVersion: resultPluginVersion,
        schemaId: schemaId ?? current.schema_id ?? undefined,
        schemaVersion: schemaVersion ?? current.schema_version ?? undefined,
        providerId: providerId ?? current.provider_id ?? undefined,
        baseUrl: (effectiveBaseUrl !== undefined ? effectiveBaseUrl : current.base_url) ?? undefined,
        secretPayload: secretPayload(secret),
      })
      if (!checked.ok) return fail(checked.code, checked.message)
      schemaId = checked.schemaId
      schemaVersion = checked.schemaVersion
      effectiveBaseUrl = checked.baseUrl
    }
  }
  const nextConfigured = {
    ...currentConfigured,
    ...(hasNewSecret
      ? {
        hasApiKey: secretHasApiKey(secret),
        apiKeyFingerprint: fingerprint,
        baseUrl: (effectiveBaseUrl !== undefined ? effectiveBaseUrl : current.base_url) || null,
        legacyFormat: !secret.payloadObject,
      }
      : {}),
    ...(nextPluginId !== undefined ? { pluginId: nextPluginId } : {}),
    ...(nextPluginVersion !== undefined ? { pluginVersion: nextPluginVersion } : {}),
  }
  // A stored (masked) secret must never be silently redirected to another
  // host or plugin: changing the base URL or explicit plugin identity
  // requires a newly supplied secret in the same request.
  const redirectTo = {
    baseUrl: effectiveBaseUrl !== undefined ? effectiveBaseUrl : current.base_url,
    pluginId: nextPluginId !== undefined ? nextPluginId : currentConfigured.pluginId,
    pluginVersion: nextPluginVersion !== undefined ? nextPluginVersion : currentConfigured.pluginVersion,
  }
  if (!hasNewSecret && credentialTargetChanged(
    { baseUrl: current.base_url, pluginId: currentConfigured.pluginId, pluginVersion: currentConfigured.pluginVersion },
    redirectTo,
  )) {
    return fail('INVALID_INPUT', '更换 Base URL 或插件身份时必须同时提供新的凭据内容')
  }
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

// Explicit plugin identity for a media credential probe. A linked model row
// wins; otherwise the credential's own configured plugin identity applies.
// Returns null when the credential carries no plugin identity — callers must
// surface a clear error instead of guessing a plugin from provider/adapter.
export function resolveCredentialPlugin(
  linked: { plugin_id?: unknown; plugin_version?: unknown } | null | undefined,
  credentialRow: Record<string, unknown>,
): { pluginId: string; pluginVersion: string } | null {
  const linkedId = typeof linked?.plugin_id === 'string' && linked.plugin_id.trim() ? linked.plugin_id.trim() : null
  const linkedVersion = typeof linked?.plugin_version === 'string' && linked.plugin_version.trim() ? linked.plugin_version.trim() : null
  if (linkedId && linkedVersion) return { pluginId: linkedId, pluginVersion: linkedVersion }
  const configured = credentialRow.configured_fields
  const fields = typeof configured === 'object' && configured !== null
    ? configured as Record<string, unknown>
    : typeof configured === 'string'
      ? ((): Record<string, unknown> => {
        try {
          const parsed = JSON.parse(configured) as unknown
          return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
        } catch {
          return {}
        }
      })()
      : {}
  const configuredId = typeof fields.pluginId === 'string' && fields.pluginId.trim() ? fields.pluginId.trim() : null
  const configuredVersion = typeof fields.pluginVersion === 'string' && fields.pluginVersion.trim() ? fields.pluginVersion.trim() : null
  if (linkedId && configuredVersion) return { pluginId: linkedId, pluginVersion: configuredVersion }
  if (configuredId && configuredVersion) return { pluginId: configuredId, pluginVersion: configuredVersion }
  if (configuredId && linkedVersion) return { pluginId: configuredId, pluginVersion: linkedVersion }
  return null
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
  const linked = await db().query(
    `SELECT id,model_kind,plugin_id,plugin_version,vendor_model_id,base_url
       FROM model_configs
      WHERE provider_credential_id=$1 AND deleted_at IS NULL
      ORDER BY CASE WHEN model_kind='language' THEN 0 ELSE 1 END,created_at ASC
      LIMIT 1`,
    [id],
  )
  if (linked.rows[0]?.model_kind === 'language') {
    return testLanguageModel(linked.rows[0].id)
  }
  if (row.adapter === 'anthropic' || providerId === 'anthropic') {
    return fail('PROMPT_MODEL_NOT_CONFIGURED', '请先将该凭据关联到语言模型')
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
        createExecutionContext: (id: string, version: string, options?: { config?: unknown }) => unknown
      }
      decodeCredential: (raw: unknown, schemaHint?: string, pluginId?: string, version?: string) => { apiKey?: string; baseUrl?: string; schema: string }
    }
    const resolved = resolveCredentialPlugin(linked.rows[0], row)
    if (!resolved) {
      await db().query(
        'UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3',
        ['failed', 'PLUGIN_NOT_LINKED', id],
      )
      return fail('PLUGIN_NOT_LINKED', '该凭据尚未关联供应商插件（缺少 pluginId/pluginVersion），请先关联模型或配置插件身份后再测试')
    }
    const { pluginId, pluginVersion } = resolved
    if (!providers.globalProviderRegistry.has(pluginId, pluginVersion)) {
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
      const context = providers.globalProviderRegistry.createExecutionContext(pluginId, pluginVersion, { config })
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
