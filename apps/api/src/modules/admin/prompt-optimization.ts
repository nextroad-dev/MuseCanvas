import { db, transaction } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { decryptApiKey } from '../../auth/security'
import { callLanguageModel } from '../../../../../packages/providers/src/index'

const optimizationSettingsDto = (row: any) => ({
  enabled: row.enabled,
  allowUserReadFinalPrompt: row.allow_user_read_final_prompt,
  languageModelConfigId: row.language_model_config_id || null,
  timeoutMs: row.timeout_ms,
  updatedAt: row.updated_at.toISOString(),
})

export async function updatePromptOptimizationSettings(
  actor: Actor,
  input: Record<string, unknown>,
) {
  if ('maxOutputChars' in input) return fail('INVALID_INPUT', '前处理设置已移除最大输出字符参数')
  if ('timeoutMs' in input) return fail('INVALID_INPUT', '前处理超时已固定为 600 秒')
  if (
    (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
    (input.allowUserReadFinalPrompt !== undefined &&
      typeof input.allowUserReadFinalPrompt !== 'boolean')
  )
    return fail('INVALID_INPUT', '前处理设置无效')
  const current = (
    await db().query('SELECT * FROM prompt_optimization_settings WHERE singleton=true')
  ).rows[0]
  const modelId =
    input.languageModelConfigId === undefined
      ? current.language_model_config_id
      : input.languageModelConfigId
  const enabled = input.enabled === undefined ? current.enabled : input.enabled
  if (modelId !== null && (typeof modelId !== 'string' || !/^[0-9a-f-]{36}$/i.test(modelId)))
    return fail('INVALID_INPUT', '语言模型无效')
  if (modelId) {
    const model = await db().query(
      `SELECT m.id FROM model_configs m JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.id=$1 AND m.model_kind='language' AND m.enabled=true AND m.deleted_at IS NULL AND pc.enabled=true AND pc.api_key_encrypted IS NOT NULL`,
      [modelId],
    )
    if (!model.rows[0])
      return fail('LANGUAGE_MODEL_CONFIG_INVALID', '请选择已启用且凭据完整的语言模型')
  }
  if (enabled && !modelId) return fail('PROMPT_MODEL_NOT_CONFIGURED', '启用前请先选择语言模型')
  const timeoutMs = 600_000
  const updated = await transaction(async (client) => {
    const r = await client.query(
      `UPDATE prompt_optimization_settings SET enabled=$1,allow_user_read_final_prompt=$2,language_model_config_id=$3,timeout_ms=$4,updated_by=$5,updated_at=now() WHERE singleton=true RETURNING *`,
      [
        enabled,
        input.allowUserReadFinalPrompt === undefined
          ? current.allow_user_read_final_prompt
          : input.allowUserReadFinalPrompt,
        modelId,
        timeoutMs,
        actor.id,
      ],
    )
    return r.rows[0]
  })
  return ok(optimizationSettingsDto(updated))
}

export async function testLanguageModel(id: string) {
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