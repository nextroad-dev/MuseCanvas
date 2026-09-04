import { createHash } from 'node:crypto'
import { db, transaction } from '../../../../../packages/database/src/index'
import { createModelConfigRevision } from '@musecanvas/database'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { capabilitiesFromRow, defaultsFromRow, modelDto, pricingFromRow } from '../../shared/dto'
import { normalizedProviderBaseUrl, presetById, sanitizeReasoningEffort } from '../../shared/model-helpers'

// Static plugin catalog. Image plugins are registered in the provider package;
// video plugins (seedance-video, veo-video) are integrated in parallel and may
// not be registered yet at runtime, so the exact IDs below are the contract and
// registry validation is best-effort (deferred dynamic import).
const KNOWN_PLUGINS: Record<string, { providerId: string; mediaKind: 'image' | 'video' }> = {
  'openai-image@1.0.0': { providerId: 'openai', mediaKind: 'image' },
  'seedream-image@1.0.0': { providerId: 'volcengine', mediaKind: 'image' },
  'seedance-video@1.0.0': { providerId: 'volcengine', mediaKind: 'video' },
  'veo-video@1.0.0': { providerId: 'google', mediaKind: 'video' },
}

async function registryKnowsPlugin(pluginId: string, version: string): Promise<boolean | null> {
  try {
    const mod = (await import('@musecanvas/providers')) as unknown as {
      globalProviderRegistry?: { has: (id: string, version: string) => boolean }
    }
    if (!mod.globalProviderRegistry) return null
    return mod.globalProviderRegistry.has(pluginId, version)
  } catch {
    return null
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`
}

function snapshotDigest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function buildPluginCapabilities(
  pluginId: string,
  mediaKind: 'image' | 'video',
  input: Record<string, unknown>,
  fallbackRow?: Record<string, unknown> | null,
): Record<string, unknown> {
  const provided = asRecord(input.capabilities)
  if (provided && (Array.isArray(provided.modes) || Array.isArray(provided.parameters))) {
    return {
      modes: provided.modes ?? [],
      parameters: provided.parameters ?? [],
      inputSlots: provided.inputSlots ?? [],
      maxCount: provided.maxCount ?? 1,
      supportedMediaKinds: provided.supportedMediaKinds ?? [mediaKind],
      mediaKind,
    }
  }
  if (mediaKind === 'video') {
    return {
      modes: provided?.modes ?? ['text_to_video', 'image_to_video'],
      parameters: provided?.parameters ?? [
        { type: 'integer', name: 'durationSeconds', label: '时长（秒）', min: 1, max: 60, defaultValue: 5 },
        { type: 'enum', name: 'aspectRatio', label: '宽高比', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], defaultValue: '16:9' },
        { type: 'enum', name: 'resolution', label: '分辨率', options: ['720p', '1080p'], defaultValue: '720p' },
        { type: 'boolean', name: 'audio', label: '生成音频', defaultValue: true },
        { type: 'integer', name: 'count', label: '生成数量', min: 1, max: 4, defaultValue: 1 },
      ],
      inputSlots: provided?.inputSlots ?? [
        { role: 'first_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] },
        { role: 'last_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] },
        { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] },
      ],
      maxCount: 4,
      supportedMediaKinds: ['video'],
      mediaKind,
      pluginId,
    }
  }
  if (fallbackRow) {
    const legacy = capabilitiesFromRow(fallbackRow)
    return {
      modes: legacy.modes,
      parameters: legacy.parameters,
      inputSlots: legacy.inputSlots,
      maxCount: legacy.maxCount,
      supportedMediaKinds: legacy.supportedMediaKinds,
      mediaKind,
    }
  }
  return { modes: [], parameters: [], inputSlots: [], maxCount: 1, supportedMediaKinds: [mediaKind], mediaKind }
}

function buildPluginPricing(
  mediaKind: 'image' | 'video',
  input: Record<string, unknown>,
  fallbackCreditsPerImage: number,
): { pricing: Record<string, unknown>; creditsPerImage: number } {
  const provided = asRecord(input.pricing)
  if (provided && typeof provided.scheme === 'string') {
    if (provided.scheme === 'per_image_v1') {
      const credits = Number(provided.creditsPerImage)
      if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('INVALID_PRICING')
      return { pricing: { scheme: 'per_image_v1', creditsPerImage: credits }, creditsPerImage: credits }
    }
    if (provided.scheme === 'per_second_v1') {
      const credits = Number(provided.creditsPerSecond)
      if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('INVALID_PRICING')
      const min = provided.minDurationSeconds !== undefined ? Number(provided.minDurationSeconds) : undefined
      const max = provided.maxDurationSeconds !== undefined ? Number(provided.maxDurationSeconds) : undefined
      if ((min !== undefined && (!Number.isInteger(min) || min < 1)) || (max !== undefined && (!Number.isInteger(max) || max < 1))) {
        throw new Error('INVALID_PRICING')
      }
      return {
        pricing: { scheme: 'per_second_v1', creditsPerSecond: credits, ...(min !== undefined ? { minDurationSeconds: min } : {}), ...(max !== undefined ? { maxDurationSeconds: max } : {}) },
        creditsPerImage: 0,
      }
    }
    throw new Error('INVALID_PRICING')
  }
  if (mediaKind === 'video') {
    return { pricing: { scheme: 'per_second_v1', creditsPerSecond: 10, minDurationSeconds: 1, maxDurationSeconds: 60 }, creditsPerImage: 0 }
  }
  if (!Number.isSafeInteger(fallbackCreditsPerImage) || fallbackCreditsPerImage < 0) throw new Error('INVALID_PRICING')
  return { pricing: { scheme: 'per_image_v1', creditsPerImage: fallbackCreditsPerImage }, creditsPerImage: fallbackCreditsPerImage }
}

async function snapshotRevisionForRow(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  row: Record<string, unknown>,
  actorId: string,
): Promise<Record<string, unknown>> {
  const providerId = (row.provider_id as string) || 'legacy'
  const pluginId = (row.plugin_id as string) || 'legacy-image'
  const pluginVersion = (row.plugin_version as string) || '1.0.0'
  const capabilities = capabilitiesFromRow(row) as unknown as Record<string, unknown>
  const pricing = pricingFromRow(row)
  const defaults = { ...(defaultsFromRow(row)), ...(asRecord(row.defaults) || {}) }
  const digest = snapshotDigest({ modelId: row.id, providerId, pluginId, pluginVersion, capabilities, pricing, defaults })
  const existing = await client.query(
    'SELECT id FROM model_config_revisions WHERE model_id=$1 AND snapshot_digest=$2 ORDER BY revision DESC LIMIT 1',
    [row.id, digest],
  )
  let revisionId = existing.rows[0]?.id as string | undefined
  let revision = existing.rows[0] ? Number((await client.query('SELECT revision FROM model_config_revisions WHERE id=$1', [revisionId])).rows[0]?.revision || 1) : 1
  if (!revisionId) {
    const created = await createModelConfigRevision(client as never, {
      modelId: row.id as string,
      providerId,
      pluginId,
      pluginVersion,
      vendorModelId: (row.vendor_model_id as string) || null,
      baseUrl: (row.base_url as string) || null,
      credentialId: (row.provider_credential_id as string) || null,
      credentialSchemaVersion: 1,
      capabilities,
      pricing,
      normalizedConfig: {
        vendorModelId: row.vendor_model_id,
        baseUrl: row.base_url,
        concurrencyLimit: row.concurrency_limit,
        watermark: row.watermark,
        modelKind: row.model_kind,
      },
      defaults,
      snapshotDigest: digest,
      createdBy: actorId,
    })
    revisionId = created.id
    revision = created.revision
  } else {
    await client.query('UPDATE model_configs SET latest_revision_id=$1 WHERE id=$2', [revisionId, row.id])
  }
  return { ...row, capabilities, pricing, defaults, revision, latest_revision_id: revisionId }
}

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

  // Plugin-driven path: explicit provider/plugin identity (image or video).
  // Accepts providerId/pluginId/pluginVersion plus capability/pricing/defaults JSON,
  // preserving legacy adapter fields for existing clients.
  if (typeof input.pluginId === 'string' && input.pluginId.trim()) {
    const pluginId = input.pluginId.trim()
    const pluginVersion = typeof input.pluginVersion === 'string' && input.pluginVersion.trim()
      ? input.pluginVersion.trim()
      : '1.0.0'
    const known = KNOWN_PLUGINS[`${pluginId}@${pluginVersion}`]
    const registryKnown = await registryKnowsPlugin(pluginId, pluginVersion)
    if (!known && registryKnown !== true) return fail('INVALID_PLUGIN', '供应商插件不存在或版本不受支持')
    const mediaKind = (typeof input.modelKind === 'string' && ['image', 'video'].includes(input.modelKind)
      ? input.modelKind
      : known?.mediaKind || existing?.model_kind || 'video') as 'image' | 'video'
    const providerId = (typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : known?.providerId || existing?.provider_id || null) as string | null
    if (!providerId) return fail('INVALID_INPUT', '供应商 ID（providerId）必填')
    const displayName = (typeof input.displayName === 'string' && input.displayName.trim()
      ? input.displayName.trim()
      : existing?.display_name) as string | undefined
    if (!displayName) return fail('INVALID_INPUT', '模型名称不能为空')
    const vendorModelId = (typeof input.vendorModelId === 'string' && input.vendorModelId.trim()
      ? input.vendorModelId.trim()
      : existing?.vendor_model_id) as string | undefined
    if (!vendorModelId) return fail('INVALID_INPUT', '供应商模型 ID（vendorModelId）必填')
    const baseUrl = input.baseUrl !== undefined
      ? normalizedProviderBaseUrl(input.baseUrl)
      : (existing?.base_url ?? undefined)
    if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
    const credId = input.providerCredentialId
    const effectiveCredId = credId === undefined ? existing?.provider_credential_id : credId
    if (typeof effectiveCredId === 'string' && effectiveCredId) {
      const cred = await db().query('SELECT id FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [effectiveCredId])
      if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
    }
    const concurrencyLimit = input.concurrencyLimit === undefined
      ? Number(existing?.concurrency_limit ?? 1)
      : Number(input.concurrencyLimit)
    const sortOrder = input.sortOrder === undefined ? Number(existing?.sort_order ?? 0) : Number(input.sortOrder)
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 50 || !Number.isInteger(sortOrder)) {
      return fail('INVALID_INPUT', '并发或排序配置无效')
    }
    let pricing: Record<string, unknown>
    let creditsPerImage = 0
    try {
      const built = buildPluginPricing(mediaKind, input, Number(input.creditsPerImage ?? existing?.credits_per_image ?? 0))
      pricing = built.pricing
      creditsPerImage = built.creditsPerImage
    } catch {
      return fail('INVALID_INPUT', '模型计费配置无效')
    }
    const capabilities = buildPluginCapabilities(pluginId, mediaKind, input, existing)
    const defaults = { ...(asRecord(input.defaults) || {}) }
    const watermark = typeof input.watermark === 'boolean' ? input.watermark : Boolean(existing?.watermark ?? false)
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(existing?.enabled ?? false)
    const sizes = mediaKind === 'image'
      ? (Array.isArray(input.sizes) ? JSON.stringify((input.sizes as unknown[]).map(String)) : existing?.sizes ? JSON.stringify(existing.sizes) : JSON.stringify([]))
      : null
    const qualityOptions = mediaKind === 'image'
      ? (Array.isArray(input.qualityOptions) ? JSON.stringify((input.qualityOptions as unknown[]).map(String)) : existing?.quality_options ? JSON.stringify(existing.quality_options) : JSON.stringify([]))
      : JSON.stringify([])
    const maxCount = mediaKind === 'image'
      ? (input.maxCount !== undefined ? Number(input.maxCount) : Number(existing?.max_count ?? 1))
      : (input.maxCount !== undefined ? Number(input.maxCount) : 1)
    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 10) return fail('INVALID_INPUT', '模型配置无效')
    const maxInputImages = input.maxInputImages !== undefined
      ? Number(input.maxInputImages)
      : Number(existing?.max_input_images ?? (mediaKind === 'video' ? 4 : 0))
    if (!Number.isInteger(maxInputImages) || maxInputImages < 0 || maxInputImages > 32) {
      return fail('INVALID_INPUT', '模型输入配置无效')
    }
    const row = await transaction(async (client) => {
      let record: Record<string, unknown>
      if (id) {
        const updated = await client.query(
          `UPDATE model_configs SET display_name=$1,vendor_model_id=$2,base_url=$3,sizes=$4::jsonb,quality_options=$5::jsonb,max_count=$6,
            concurrency_limit=$7,enabled=$8,watermark=$9,sort_order=$10,
            provider_credential_id=CASE WHEN $11::text IS NULL THEN provider_credential_id WHEN $11::text = '' THEN NULL ELSE $11::uuid END,
            model_kind=$12,provider_id=$13,plugin_id=$14,plugin_version=$15,max_input_images=$16,credits_per_image=$17,updated_at=now()
           WHERE id=$18 AND deleted_at IS NULL RETURNING *`,
          [displayName, vendorModelId, baseUrl === undefined ? existing?.base_url || null : baseUrl || null,
            sizes, qualityOptions, maxCount, concurrencyLimit, enabled, watermark, sortOrder,
            credId === undefined ? null : credId, mediaKind, providerId, pluginId, pluginVersion,
            maxInputImages, creditsPerImage, id],
        )
        if (!updated.rows[0]) throw new Error('NOT_FOUND')
        record = updated.rows[0]
      } else {
        const inserted = await client.query(
          `INSERT INTO model_configs(display_name,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,
            watermark,sort_order,created_by,provider_credential_id,model_kind,provider_id,plugin_id,plugin_version,max_input_images,credits_per_image)
           VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [displayName, vendorModelId, baseUrl || null, sizes, qualityOptions, maxCount, concurrencyLimit, enabled,
            watermark, sortOrder, actor.id,
            typeof effectiveCredId === 'string' && effectiveCredId ? effectiveCredId : null,
            mediaKind, providerId, pluginId, pluginVersion, maxInputImages, creditsPerImage],
        )
        record = inserted.rows[0]
      }
      const digest = snapshotDigest({ modelId: record.id, providerId, pluginId, pluginVersion, capabilities, pricing, defaults })
      const created = await createModelConfigRevision(client as never, {
        modelId: record.id as string,
        providerId,
        pluginId,
        pluginVersion,
        vendorModelId,
        baseUrl: (baseUrl === undefined ? existing?.base_url : baseUrl) as string | null,
        credentialId: (typeof effectiveCredId === 'string' && effectiveCredId ? effectiveCredId : null) as string | null,
        credentialSchemaVersion: 1,
        capabilities,
        pricing,
        normalizedConfig: { vendorModelId, concurrencyLimit, watermark, modelKind: mediaKind },
        defaults,
        snapshotDigest: digest,
        createdBy: actor.id,
      })
      await client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [
        actor.id, id ? 'model.update' : 'model.create', 'model', record.id, { pluginId, pluginVersion },
      ])
      return { ...record, capabilities, pricing, defaults, revision: created.revision, latest_revision_id: created.id }
    })
    return ok(modelDto(row))
  }

  const forbiddenManualFields = [
    'displayName', 'adapter', 'vendorModelId', 'baseUrl', 'sizes', 'qualityOptions', 'maxCount',
    'modelKind', 'languageProtocol', 'maxOutputTokens', 'temperature', 'maxInputImages',
    'providerId', 'pluginId', 'pluginVersion', 'capabilities', 'pricing', 'defaults',
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
  if (targetKind === 'language' && (typeof effectiveCredId !== 'string' || !effectiveCredId))
    return fail('LANGUAGE_MODEL_CONFIG_INVALID', '语言模型必须选择供应商凭据')
  if (typeof effectiveCredId === 'string' && effectiveCredId) {
    const cred = await db().query('SELECT id FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [effectiveCredId])
    if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
  }
  if (targetPreset && 'adapter' in targetPreset && !['openai', 'seedream', 'anthropic'].includes(String(targetPreset.adapter)))
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

  const creditsPerImage =
    input.creditsPerImage !== undefined
      ? Number(input.creditsPerImage)
      : existing?.credits_per_image !== undefined
      ? Number(existing.credits_per_image)
      : 0
  if (!Number.isSafeInteger(creditsPerImage) || creditsPerImage < 0) {
    return fail('INVALID_INPUT', '模型单张图片积分必须为大于或等于0的安全整数')
  }

  let result
  if (id && !targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET concurrency_limit=$1,enabled=COALESCE($2,enabled),watermark=COALESCE($3,watermark),sort_order=$4,provider_credential_id=CASE WHEN $5::text IS NULL THEN provider_credential_id WHEN $5::text = '' THEN NULL ELSE $5::uuid END,reasoning_effort=CASE WHEN model_kind='language' THEN $6 ELSE NULL END,credits_per_image=$7,updated_at=now() WHERE id=$8 AND deleted_at IS NULL RETURNING *`,
      [
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        typeof input.watermark === 'boolean' ? input.watermark : null,
        sortOrder,
        credId === undefined ? null : credId,
        reasoningEffort ?? null,
        creditsPerImage,
        id,
      ],
    )
  } else if (id && targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET preset_id=$1,display_name=$2,adapter=$3,vendor_model_id=$4,base_url=$5,sizes=$6,quality_options=$7,max_count=$8,concurrency_limit=$9,enabled=COALESCE($10,enabled),watermark=$11,sort_order=$12,provider_credential_id=CASE WHEN $13::text IS NULL THEN provider_credential_id WHEN $13::text = '' THEN NULL ELSE $13::uuid END,model_kind=$14,language_protocol=$15,max_output_tokens=$16,temperature=$17,reasoning_effort=$18,max_input_images=$19,credits_per_image=$20,provider_id=$21,plugin_id=$22,plugin_version=$23,updated_at=now() WHERE id=$24 AND deleted_at IS NULL RETURNING *`,
      [
        targetPreset.id,
        targetPreset.displayName,
        'adapter' in targetPreset ? targetPreset.adapter : existing?.adapter,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]',
        targetPreset.modelKind === 'image' ? targetPreset.maxCount : targetPreset.modelKind === 'video' ? targetPreset.maxCount : null,
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        (targetPreset.modelKind === 'image' || targetPreset.modelKind === 'video') &&
          (typeof input.watermark === 'boolean' ? input.watermark : 'watermark' in targetPreset ? targetPreset.watermark : false),
        sortOrder,
        credId === undefined ? null : credId,
        targetPreset.modelKind,
        targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null,
        targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null,
        targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined
          ? targetPreset.temperature
          : null,
        targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null,
        targetPreset.modelKind === 'image' ? (targetPreset.maxInputImages ?? 0) : targetPreset.modelKind === 'video' ? 4 : 0,
        targetPreset.modelKind === 'video' ? 0 : creditsPerImage,
        'providerId' in targetPreset ? targetPreset.providerId : existing?.provider_id || null,
        'pluginId' in targetPreset ? targetPreset.pluginId : existing?.plugin_id || null,
        'pluginVersion' in targetPreset ? targetPreset.pluginVersion : existing?.plugin_version || '1.0.0',
        id,
      ],
    )
  } else if (targetPreset) {
    result = await db().query(
      'INSERT INTO model_configs(preset_id,display_name,adapter,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,watermark,sort_order,created_by,provider_credential_id,model_kind,language_protocol,max_output_tokens,temperature,reasoning_effort,max_input_images,credits_per_image,provider_id,plugin_id,plugin_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *',
      [
        targetPreset.id,
        targetPreset.displayName,
        'adapter' in targetPreset ? targetPreset.adapter : null,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null,
        targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]',
        targetPreset.modelKind === 'image' ? targetPreset.maxCount : targetPreset.modelKind === 'video' ? targetPreset.maxCount : null,
        concurrencyLimit,
        input.enabled === true,
        (targetPreset.modelKind === 'image' || targetPreset.modelKind === 'video') &&
          (typeof input.watermark === 'boolean' ? input.watermark : 'watermark' in targetPreset ? targetPreset.watermark : false),
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
        targetPreset.modelKind === 'image' ? (targetPreset.maxInputImages ?? 0) : targetPreset.modelKind === 'video' ? 4 : 0,
        targetPreset.modelKind === 'video' ? 0 : creditsPerImage,
        'providerId' in targetPreset ? targetPreset.providerId : null,
        'pluginId' in targetPreset ? targetPreset.pluginId : null,
        'pluginVersion' in targetPreset ? targetPreset.pluginVersion : '1.0.0',
      ],
    )
  } else {
    return fail('INVALID_PRESET', '请选择模型预设')
  }
  if (!result.rows[0]) return fail('NOT_FOUND', '模型不存在', 404)
  await db().query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, id ? 'model.update' : 'model.create', 'model', result.rows[0].id, {}])
  try {
    const withRevision = await snapshotRevisionForRow(db(), result.rows[0], actor.id)
    return ok(modelDto(withRevision))
  } catch {
    return ok(modelDto(result.rows[0]))
  }
}

export async function deleteModel(actor: Actor, id: string) {
  const deleted = await transaction(async (client) => {
    const r = await client.query(
      'UPDATE model_configs SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [id],
    )
    if (!r.rows[0]) return false
    await client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, 'model.delete', 'model', id, {}])
    await client.query(
      'UPDATE prompt_optimization_settings SET enabled=false,language_model_config_id=NULL,updated_by=$2,updated_at=now() WHERE language_model_config_id=$1',
      [id, actor.id],
    )
    return true
  })
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '模型不存在', 404)
}
