import { db, transaction } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { modelDto } from '../../shared/dto'
import { presetById, sanitizeReasoningEffort } from '../../shared/model-helpers'

export async function upsertModel(
  actor: Actor,
  input: Record<string, unknown>,
  id?: string,
) {
  const existing = id
    ? (await db().query('SELECT * FROM model_configs WHERE id=$1 AND deleted_at IS NULL', [id]))
        .rows[0]
    : null
  if (id && !existing) return fail('NOT_FOUND', '模型不存在', 404)
  const forbiddenManualFields = [
    'displayName',
    'adapter',
    'vendorModelId',
    'baseUrl',
    'sizes',
    'qualityOptions',
    'maxCount',
    'languageProtocol',
    'maxOutputTokens',
    'temperature',
    'modelKind',
  ]
  if (forbiddenManualFields.some((field) => input[field] !== undefined))
    return fail('INVALID_INPUT', '模型参数只能通过预设选择')
  const preset =
    input.presetId === undefined
      ? existing?.preset_id
        ? presetById(existing.preset_id)
        : null
      : presetById(input.presetId)
  if (!id && !preset) return fail('INVALID_PRESET', '请选择模型预设')
  if (input.presetId !== undefined && !preset) return fail('INVALID_PRESET', '模型预设不存在')
  const targetPreset = preset
  const credId = input.providerCredentialId
  const effectiveCredId = credId === undefined ? existing?.provider_credential_id : credId
  const targetKind = targetPreset?.modelKind || existing?.model_kind || 'image'
  const targetAdapter = targetPreset?.adapter || existing?.adapter
  if (targetKind === 'language' && (typeof effectiveCredId !== 'string' || !effectiveCredId))
    return fail('LANGUAGE_MODEL_CONFIG_INVALID', '语言模型必须选择供应商凭据')
  if (typeof effectiveCredId === 'string' && effectiveCredId) {
    const cred = await db().query(
      'SELECT adapter,enabled,api_key_encrypted FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
      [effectiveCredId],
    )
    if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
    if (targetKind === 'language') {
      if (!cred.rows[0].enabled || !cred.rows[0].api_key_encrypted)
        return fail('LANGUAGE_MODEL_CONFIG_INVALID', '请选择已启用且凭据完整的供应商凭据')
    }
    if (cred.rows[0].adapter !== targetAdapter) {
      return fail('INVALID_INPUT', '供应商凭据类型与模型不匹配')
    }
  }
  if (!['openai', 'seedream', 'anthropic'].includes(String(targetAdapter)))
    return fail('INVALID_INPUT', '模型配置无效')
  const concurrencyLimit =
    input.concurrencyLimit === undefined
      ? existing?.concurrency_limit ?? targetPreset?.concurrencyLimit ?? 1
      : Number(input.concurrencyLimit)
  const sortOrder =
    input.sortOrder === undefined ? existing?.sort_order ?? 0 : Number(input.sortOrder)
  if (
    !Number.isInteger(concurrencyLimit) ||
    concurrencyLimit < 1 ||
    concurrencyLimit > 50 ||
    !Number.isInteger(sortOrder)
  )
    return fail('INVALID_INPUT', '并发或排序配置无效')
  const reasoningFallback =
    existing?.reasoning_effort ||
    (targetPreset && 'reasoningEffort' in targetPreset ? targetPreset.reasoningEffort : null) ||
    'medium'
  const reasoningEffort =
    targetKind === 'language' ? sanitizeReasoningEffort(input.reasoningEffort, reasoningFallback) : null
  if (reasoningEffort === undefined && targetKind === 'language')
    return fail('INVALID_INPUT', '思考等级无效')
  let result
  if (id && !targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET concurrency_limit=$1,enabled=COALESCE($2,enabled),watermark=COALESCE($3,watermark),sort_order=$4,provider_credential_id=CASE WHEN $5::text IS NULL THEN provider_credential_id WHEN $5::text = '' THEN NULL ELSE $5::uuid END,reasoning_effort=CASE WHEN model_kind='language' THEN $6 ELSE NULL END,updated_at=now() WHERE id=$7 AND deleted_at IS NULL RETURNING *`,
      [
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        typeof input.watermark === 'boolean' ? input.watermark : null,
        sortOrder,
        credId === undefined ? null : credId,
        reasoningEffort ?? null,
        id,
      ],
    )
  } else if (id && targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET preset_id=$1,display_name=$2,adapter=$3,vendor_model_id=$4,base_url=$5,sizes=$6,quality_options=$7,max_count=$8,concurrency_limit=$9,enabled=COALESCE($10,enabled),watermark=$11,sort_order=$12,provider_credential_id=CASE WHEN $13::text IS NULL THEN provider_credential_id WHEN $13::text = '' THEN NULL ELSE $13::uuid END,model_kind=$14,language_protocol=$15,max_output_tokens=$16,temperature=$17,reasoning_effort=$18,updated_at=now() WHERE id=$19 AND deleted_at IS NULL RETURNING *`,
      [
        targetPreset.id,
        targetPreset.displayName,
        targetPreset.adapter,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]',
        targetPreset.modelKind === 'image' ? targetPreset.maxCount : null,
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        targetPreset.modelKind === 'image' &&
          (typeof input.watermark === 'boolean' ? input.watermark : targetPreset.watermark),
        sortOrder,
        credId === undefined ? null : credId,
        targetPreset.modelKind,
        targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null,
        targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null,
        targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined
          ? targetPreset.temperature
          : null,
        targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null,
        id,
      ],
    )
  } else if (targetPreset) {
    result = await db().query(
      'INSERT INTO model_configs(preset_id,display_name,adapter,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,watermark,sort_order,created_by,provider_credential_id,model_kind,language_protocol,max_output_tokens,temperature,reasoning_effort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
      [
        targetPreset.id,
        targetPreset.displayName,
        targetPreset.adapter,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]',
        targetPreset.modelKind === 'image' ? targetPreset.maxCount : null,
        concurrencyLimit,
        input.enabled === true,
        targetPreset.modelKind === 'image' &&
          (typeof input.watermark === 'boolean' ? input.watermark : targetPreset.watermark),
        sortOrder,
        actor.id,
        typeof credId === 'string' && credId ? credId : null,
        targetPreset.modelKind,
        targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null,
        targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null,
        targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined
          ? targetPreset.temperature
          : null,
        targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null,
      ],
    )
  } else {
    return fail('INVALID_PRESET', '请选择模型预设')
  }
  if (!result.rows[0]) return fail('NOT_FOUND', '模型不存在', 404)
  await db().query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, id ? 'model.update' : 'model.create', 'model', result.rows[0].id, {}])
  return ok(modelDto(result.rows[0]))
}

export async function deleteModel(actor: Actor, id: string) {
  const deleted = await transaction(async (client) => {
    const r = await client.query(
      'UPDATE model_configs SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [id],
    )
    if (!r.rows[0]) return false
    await client.query(
      'UPDATE prompt_optimization_settings SET enabled=false,language_model_config_id=NULL,updated_by=$2,updated_at=now() WHERE language_model_config_id=$1',
      [id, actor.id],
    )
    return true
  })
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '模型不存在', 404)
}