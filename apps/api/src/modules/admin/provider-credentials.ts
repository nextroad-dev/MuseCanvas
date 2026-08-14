import { db } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { providerCredentialDto } from '../../shared/dto'
import { normalizedProviderBaseUrl } from '../../shared/model-helpers'
import { callLanguageModel, providerEndpoint, providerModelsEndpoint } from '../../../../../packages/providers/src/index'
import { decryptApiKey } from '../../auth/security'

export async function createProviderCredential(actor: Actor, input: Record<string, unknown>) {
  const adapter = input.adapter
  if (adapter !== 'openai' && adapter !== 'seedream' && adapter !== 'anthropic')
    return fail('INVALID_INPUT', '供应商类型无效')
  if (typeof input.displayName !== 'string' || !input.displayName.trim())
    return fail('INVALID_INPUT', '凭据名称不能为空')
  const baseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  let apiKeyEncrypted: string | null = null
  let fingerprint: string | null = null
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const { encryptApiKey, fingerprintApiKey } = await import('../../auth/security')
    apiKeyEncrypted = encryptApiKey(input.apiKey.trim())
    fingerprint = fingerprintApiKey(input.apiKey.trim())
  }
  const enabled = input.enabled === true
  const r = await db().query(
    'INSERT INTO provider_credentials(display_name,adapter,base_url,api_key_encrypted,api_key_fingerprint,enabled,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
    [input.displayName.trim(), adapter, baseUrl || null, apiKeyEncrypted, fingerprint, enabled, actor.id],
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
  const baseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  let apiKeyEncrypted = existing.rows[0].api_key_encrypted
  let fingerprint = existing.rows[0].api_key_fingerprint
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const { encryptApiKey, fingerprintApiKey } = await import('../../auth/security')
    apiKeyEncrypted = encryptApiKey(input.apiKey.trim())
    fingerprint = fingerprintApiKey(input.apiKey.trim())
  }
  const r = await db().query(
    'UPDATE provider_credentials SET display_name=COALESCE($1,display_name),base_url=COALESCE($2,base_url),api_key_encrypted=COALESCE($3,api_key_encrypted),api_key_fingerprint=COALESCE($4,api_key_fingerprint),enabled=COALESCE($5,enabled),updated_at=now(),updated_by=$6 WHERE id=$7 AND deleted_at IS NULL RETURNING *',
    [
      typeof input.displayName === 'string' ? input.displayName.trim() : null,
      baseUrl || undefined,
      apiKeyEncrypted,
      fingerprint,
      typeof input.enabled === 'boolean' ? input.enabled : null,
      actor.id,
      id,
    ],
  )
  if (!r.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  return ok(providerCredentialDto(r.rows[0]))
}

export async function deleteProviderCredential(id: string) {
  const used = await db().query(
    'SELECT id FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )
  if (used.rows[0])
    return fail('INVALID_OPERATION', '该凭据仍被模型引用，请先解除模型的凭据关联')
  const r = await db().query(
    'UPDATE provider_credentials SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
    [id],
  )
  if (!r.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  return ok({ deleted: true })
}

export async function testProviderCredential(id: string) {
  const cred = await db().query(
    'SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  if (!cred.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  if (!cred.rows[0].api_key_encrypted) {
    await db().query(
      "UPDATE provider_credentials SET last_test_status='failed',last_test_error_code='NO_API_KEY',last_tested_at=now() WHERE id=$1",
      [id],
    )
    return fail('INVALID_INPUT', '未配置 API Key，无法测试')
  }
  const apiKey = decryptApiKey(cred.rows[0].api_key_encrypted)
  if (cred.rows[0].adapter === 'anthropic') {
    const model = await db().query(
      "SELECT id FROM model_configs WHERE provider_credential_id=$1 AND model_kind='language' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      [id],
    )
    return model.rows[0]
      ? testLanguageModel(model.rows[0].id)
      : fail('PROMPT_MODEL_NOT_CONFIGURED', '请先将该凭据关联到语言模型')
  }
  const baseUrl =
    cred.rows[0].base_url ||
    (cred.rows[0].adapter === 'openai'
      ? 'https://api.openai.com'
      : 'https://ark.cn-beijing.volces.com')
  try {
    if (cred.rows[0].adapter === 'openai') {
      const response = await fetch(providerModelsEndpoint(baseUrl), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
    } else {
      const probe = await db().query(
        'SELECT vendor_model_id,sizes FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1',
        [id],
      )
      const probeModelId =
        typeof probe.rows[0]?.vendor_model_id === 'string' && probe.rows[0].vendor_model_id
          ? probe.rows[0].vendor_model_id
          : 'doubao-seedream-4-5-251128'
      const response = await fetch(providerEndpoint('seedream', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: probeModelId,
          prompt: 'MuseCanvas provider connectivity test',
          size: '2048x2048',
          response_format: 'url',
          watermark: false,
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
      const json = (await response.json()) as { data?: { url?: string }[] }
      if (!json.data?.some((item) => typeof item.url === 'string' && item.url.length > 0))
        throw new Error('PROVIDER_EMPTY_RESULT')
    }
    await db().query(
      "UPDATE provider_credentials SET last_test_status='success',last_test_error_code=NULL,last_tested_at=now() WHERE id=$1",
      [id],
    )
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const code =
      error instanceof Error && error.message.startsWith('HTTP_')
        ? error.message === 'HTTP_429' || Number(error.message.slice(5)) >= 500
          ? 'PROVIDER_TEMPORARY_ERROR'
          : 'PROVIDER_REJECTED'
        : error instanceof Error && error.message === 'PROVIDER_EMPTY_RESULT'
          ? 'PROVIDER_EMPTY_RESULT'
          : error instanceof Error && error.message === 'PROVIDER_NOT_CONFIGURED'
            ? 'NO_API_KEY'
            : 'CONNECTIVITY_FAILED'
    await db().query(
      'UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3',
      ['failed', code, id],
    )
    return fail(
      code,
      code === 'PROVIDER_REJECTED'
        ? '凭据已连接到供应商，但被拒绝访问，请检查模型授权或 API Key 权限'
        : code === 'PROVIDER_TEMPORARY_ERROR'
          ? '供应商暂时不可用，请稍后重试'
          : code === 'PROVIDER_EMPTY_RESULT'
            ? '供应商没有返回可用图片结果'
            : '凭据测试失败，请检查 API Key 和 Base URL',
    )
  }
}

async function testLanguageModel(id: string) {
  const r = await db().query(
    `SELECT m.*,pc.api_key_encrypted,COALESCE(pc.base_url,m.base_url) effective_base_url FROM model_configs m JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.id=$1 AND m.model_kind='language' AND m.deleted_at IS NULL AND pc.enabled=true`,
    [id],
  )
  const model = r.rows[0]
  if (!model?.api_key_encrypted)
    return fail('PROMPT_MODEL_NOT_CONFIGURED', '语言模型或凭据未正确配置')
  try {
    const reasoningEffort =
      ['gpt-5.4', 'gpt-5.5'].includes(model.vendor_model_id) ? 'none' : model.reasoning_effort || undefined
    await callLanguageModel({
      protocol: model.language_protocol,
      vendorModelId: model.vendor_model_id,
      baseUrl: model.effective_base_url,
      apiKey: decryptApiKey(model.api_key_encrypted),
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