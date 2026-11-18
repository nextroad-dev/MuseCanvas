import { createHash } from 'node:crypto'
import { hasStoredCredentialSecret } from '@musecanvas/providers'
import { validateGenerationRequest, prepareRequestDigestInput, serializeCanonicalJson } from '@musecanvas/domain'
import {
  RUNTIME_SETTINGS_DEFAULTS, GenerationErrorCode,
  type CreateGenerationRequest, type ModelCapabilities, type GenerationMode,
} from '@musecanvas/contracts'
import { capabilitiesFromRow, defaultsFromRow } from '../model-snapshot'
import { GenerationInputError, attachGenerationInputs, validateInputsAgainstSlots, normalizeGenerationInputs } from '../inputs/attach'
import { MediaServiceError } from '../errors'
import type { SqlClient } from '../ports'

export interface CreateGenerationCommand {
  ownerId: string
  modelId: string
  prompt: string
  /**
   * Unified `parameters` object, when the caller sent one. Left `undefined` to
   * select the legacy flat-field path below.
   */
  parameters?: Record<string, unknown>
  /**
   * Legacy flat image fields, honoured only when `parameters` is absent. An image
   * model still owes a `size` on this path while a video model does not, so the
   * rule is applied here — after the model row is known — rather than by the
   * caller, exactly as it was while this code lived inline in the route.
   */
  legacyParameters?: { size?: unknown; quality?: unknown; count?: unknown }
  /** Inputs already normalised to `{uploadId? | assetId?, role, position}`. */
  normalizedInputs: Array<{ uploadId?: string; assetId?: string; role: string; position: number }>
  idempotencyKey: string
  inputLanguage?: string
  /** Internal frozen Agent intent. Absent for public/manual compatibility. */
  intendedMode?: GenerationMode
  /** Agent-only exact approved revision. Manual callers keep existing latest-revision semantics. */
  expectedModelRevisionId?: string
}

export interface GenerationInputLimits {
  maxImageBytes: number
  maxTotalBytes: number
  maxInputs: number
}
export interface GenerationPreparationPorts {
  database: () => SqlClient
  runtimeLimits: () => Promise<GenerationInputLimits>
}

function normalizeGeneration(cmd: CreateGenerationCommand, model: Record<string, unknown>, runtimeLimits: GenerationInputLimits) {
  const { modelId, normalizedInputs, idempotencyKey } = cmd
  const mediaKind = ((model.model_kind as string) || 'image') as 'image' | 'video'
  const capabilities = capabilitiesFromRow(model)
  const defaults = defaultsFromRow(model) as Record<string, string | number | boolean>
  // Shared parameters: the unified `parameters` object is primary; legacy image
  // fields (size/quality/count) are only a normalized compatibility path.
  let rawParameters: Record<string, unknown>
  if (cmd.parameters !== undefined) {
    rawParameters = cmd.parameters
  } else {
    rawParameters = {}
    if (typeof cmd.legacyParameters?.size === 'string') rawParameters.size = cmd.legacyParameters.size
    else if (mediaKind === 'image') throw new MediaServiceError('INVALID_INPUT', '生成参数无效')
    if (typeof cmd.legacyParameters?.quality === 'string') rawParameters.quality = cmd.legacyParameters.quality
    if (cmd.legacyParameters?.count !== undefined) rawParameters.count = Number(cmd.legacyParameters.count)
  }

  // Role-aware generic inputs; each item references either an upload (`uploadId`)
  // or a gallery image (`assetId`).
  try {
    validateInputsAgainstSlots(
      normalizedInputs,
      (capabilities.inputSlots as { role: string; required?: boolean; minCount?: number; maxCount?: number }[]) || [],
      runtimeLimits,
    )
  } catch (err) {
    if (err instanceof GenerationInputError) throw new MediaServiceError(err.code, err.message, err.status)
    throw new MediaServiceError('INVALID_INPUT', '参考图参数无效', 400)
  }
  // Apply the pinned descriptor contract before any persistence or provider dispatch.
  const undeclared = capabilities.declaredBy === 'undeclared'
    || (capabilities.declaredBy === undefined && capabilities.parameters.length === 0)
  if (undeclared) {
    throw new MediaServiceError(
      GenerationErrorCode.MODEL_CAPABILITIES_UNDECLARED,
      '该模型尚未声明参数契约，无法校验生成参数，请管理员在模型设置中重新保存该模型',
      409,
      { parameter: 'modelId', value: modelId },
    )
  }
  const validationCaps = {
    modes: capabilities.modes,
    parameters: capabilities.parameters,
    // Only the runtime ceiling is applied to a slot. The old code also forced
    // `required: false` and `minCount: 0`, which silently disabled every
    // mandatory-input rule — for video as well as image.
    inputSlots: capabilities.inputSlots.map(slot => ({
      ...slot,
      maxCount: Math.min(slot.maxCount, runtimeLimits.maxInputs),
    })),
    maxCount: capabilities.maxCount,
    supportedMediaKinds: capabilities.supportedMediaKinds,
    flags: capabilities.flags,
    crossFieldConstraints: capabilities.crossFieldConstraints,
    declaredBy: capabilities.declaredBy,
  }
  const createRequest = {
    modelId,
    prompt: cmd.prompt.trim(),
    parameters: rawParameters,
    inputs: normalizedInputs,
    idempotencyKey,
    inputLanguage: cmd.inputLanguage,
  } as CreateGenerationRequest
  const domainValidation = validateGenerationRequest(validationCaps as ModelCapabilities, createRequest, { defaults: defaults as Record<string, never> })
  if (!domainValidation.valid) {
    // Forward the structured detail so the console can grey out the exact
    // control, not just print a sentence about a form the user already filled.
    throw new MediaServiceError(domainValidation.errorCode, domainValidation.errorMessage, 400, domainValidation.errors[0]?.details)
  }
  const normalized = domainValidation.value
  if (cmd.intendedMode !== undefined) {
    const mode: GenerationMode = mediaKind === 'video' ? (normalizedInputs.length ? 'image_to_video' : 'text_to_video')
      : normalizedInputs.some(item => item.role === 'mask') ? 'inpaint' : normalizedInputs.length ? 'image_to_image' : 'text_to_image'
    const supported = mode === 'inpaint'
      ? capabilities.flags?.inpainting !== false && capabilities.flags?.mask !== false
        && capabilities.inputSlots.some(slot => slot.role === 'mask' && slot.maxCount > 0)
        && (capabilities.modes.includes(mode) || (capabilities.modes.includes('image_to_image') && capabilities.flags?.inpainting === true))
      : capabilities.modes.includes(mode)
    if (cmd.intendedMode !== mode || !supported
      || (mode === 'inpaint' && !normalizedInputs.some(item => item.role === 'reference_image'))) throw new MediaServiceError('INVALID_INPUT', '模型不支持请求的生成模式', 400)
    normalized.mode = mode
  }
  const frozenPayload = { modelId: normalized.modelId, prompt: normalized.prompt, parameters: normalized.parameters, inputs: normalized.inputs, mode: normalized.mode }
  // Exact immutable execution identity, so a caller that approved this revision
  // can refuse a later lock that resolved a different one.
  const modelRevision = {
    modelRevisionId: typeof model.revision_id === 'string' ? model.revision_id : null,
    modelRevision: typeof model.revision === 'number' || typeof model.revision === 'string' ? String(model.revision) : null,
    providerId: typeof model.provider_id === 'string' ? model.provider_id : null,
    pluginId: typeof model.plugin_id === 'string' ? model.plugin_id : null,
    pluginVersion: typeof model.plugin_version === 'string' ? model.plugin_version : null,
  }
  return { mediaKind, normalized, frozenPayload, modelRevision }
}

export interface PreparedGeneration {
  readonly command: CreateGenerationCommand
  readonly runtimeLimits: GenerationInputLimits
  readonly snapshot: ReturnType<typeof normalizeGeneration>
}

/** Resolve runtime policy before taking caller-owned transaction locks. No storage or provider IO. */
export async function prepareGeneration(command: CreateGenerationCommand, ports: GenerationPreparationPorts): Promise<PreparedGeneration> {
  const cmd = {
    ...command,
    ...(command.parameters === undefined ? {} : { parameters: structuredClone(command.parameters) }),
    ...(command.legacyParameters === undefined ? {} : { legacyParameters: structuredClone(command.legacyParameters) }),
    normalizedInputs: normalizeGenerationInputs(command.normalizedInputs),
  }
  const modelResult = await ports.database().query(
    `SELECT m.*, rev.id AS revision_id, rev.capabilities, rev.defaults, rev.revision FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL`,
    [cmd.modelId],
  )
  const model = modelResult.rows[0]
  if (!model) throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型当前不可用')
  if (cmd.expectedModelRevisionId !== undefined && model.revision_id !== cmd.expectedModelRevisionId) {
    throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型版本已更新，请重新审批', 409)
  }
  // Resolved runtime input limits (DB first) enforce both raised and
  // lowered settings; canonical defaults are the safe fallback.
  let runtimeLimits: GenerationInputLimits
  try {
    const resolved = await ports.runtimeLimits()
    runtimeLimits = {
      maxImageBytes: resolved.maxImageBytes,
      maxTotalBytes: resolved.maxTotalBytes,
      maxInputs: resolved.maxInputs,
    }
  } catch {
    runtimeLimits = {
      maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
      maxTotalBytes: RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes,
      maxInputs: RUNTIME_SETTINGS_DEFAULTS.maxInputs,
    }
  }
  return { command: cmd, runtimeLimits, snapshot: normalizeGeneration(cmd, model, runtimeLimits) }
}

export interface CreatedGeneration {
  jobId: string
  row: Record<string, unknown>
  replayed: boolean
}

/**
 * Caller fencing/reservations/link writes share this transaction's commit.
 * Never begins/commits a transaction or catches persistence errors. On ANY failure
 * the caller must roll back instead of committing partial writes.
 * Requires the current migrated schema, including media_uploads (0016_wave1_media_uploads.sql).
 */
export async function createGenerationInTransaction(client: SqlClient, prepared: PreparedGeneration): Promise<CreatedGeneration> {
  const { command: cmd, runtimeLimits } = prepared
  const { modelId, normalizedInputs, idempotencyKey } = cmd
  const { mediaKind, normalized, frozenPayload } = prepared.snapshot
  const matchingExisting = (existing: Record<string, unknown>): Record<string, unknown> => {
    if (existing.model_id !== modelId || existing.media_kind !== mediaKind
      || (cmd.expectedModelRevisionId !== undefined && existing.model_revision_id !== cmd.expectedModelRevisionId)
      || serializeCanonicalJson(existing.normalized_request) !== serializeCanonicalJson(frozenPayload)) throw new MediaServiceError('IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的生成内容', 409)
    return existing
  }
  const prompt = normalized.prompt
  const requestDigest = createHash('sha256').update(prepareRequestDigestInput(normalized)).digest('hex')
  const existing = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [cmd.ownerId, idempotencyKey])
  if (existing.rows[0]) return { jobId: String(existing.rows[0].id), row: matchingExisting(existing.rows[0]), replayed: true }

  // Lock model config and prompt optimization settings in generation transaction
  const lockedModelRes = await client.query(
    `SELECT m.*, rev.id AS revision_id, rev.capabilities AS revision_capabilities, rev.defaults AS revision_defaults, rev.revision AS revision_number FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL FOR SHARE OF m`,
    [modelId]
  )
  const lockedModel = lockedModelRes.rows[0]
  if (!lockedModel) throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型当前不可用', 409)

  const locked = normalizeGeneration(cmd, {
    ...lockedModel,
    capabilities: lockedModel.revision_capabilities,
    defaults: lockedModel.revision_defaults,
    revision: lockedModel.revision_number,
  }, runtimeLimits)
  if (serializeCanonicalJson(locked.frozenPayload) !== serializeCanonicalJson(frozenPayload)
    || (cmd.expectedModelRevisionId !== undefined
      && serializeCanonicalJson(locked.modelRevision) !== serializeCanonicalJson(prepared.snapshot.modelRevision))) {
    throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型参数契约已更新，请重新提交', 409)
  }

  const optRes = await client.query('SELECT * FROM prompt_optimization_settings WHERE singleton=true FOR SHARE')
  const optRow = optRes.rows[0] || { singleton: true, enabled: false }
  if (cmd.expectedModelRevisionId !== undefined && optRow.enabled) {
    throw new MediaServiceError('APPROVAL_CONFLICT', '已审批的精确提示词不能再次自动优化', 409)
  }

  let credId: string | null = null; let credName: string | null = null; let providerBaseUrl = lockedModel.base_url
  if (lockedModel.provider_credential_id) {
    const cred = (await client.query('SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [lockedModel.provider_credential_id])).rows[0]
    if (!cred || !cred.enabled || !hasStoredCredentialSecret(cred)) throw new MediaServiceError('PROVIDER_NOT_CONFIGURED', '生成供应商凭据未配置', 503)
    credId = String(cred.id)
    credName = String(cred.display_name)
    providerBaseUrl = cred.base_url || lockedModel.base_url
  }

  let optSettings = optRow
  if (optRow.enabled) {
    const fullOpt = await client.query(
      `SELECT s.*,m.display_name,m.vendor_model_id,m.adapter,m.language_protocol,m.max_output_tokens,m.temperature,m.reasoning_effort,m.base_url,pc.id credential_id,pc.display_name credential_name,pc.base_url credential_base_url,pc.enabled credential_enabled,pc.payload_encrypted,pc.api_key_encrypted
       FROM prompt_optimization_settings s
       LEFT JOIN model_configs m ON m.id=s.language_model_config_id AND m.deleted_at IS NULL
       LEFT JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL
       WHERE s.singleton=true`
    )
    optSettings = fullOpt.rows[0]
    if (!optSettings || !optSettings.language_model_config_id || !optSettings.language_protocol || !optSettings.credential_id || !optSettings.credential_enabled || !hasStoredCredentialSecret(optSettings)) {
      throw new MediaServiceError('PROMPT_MODEL_NOT_CONFIGURED', '提示词优化模型配置不完整', 503)
    }
  }
  const optimizationMode = optRow.enabled ? 'enabled' : 'disabled'
  const phase = optRow.enabled ? 'template_selecting' : (mediaKind === 'video' ? 'provider_submitting' : 'image_generating')

  // Generations are free: no quoting and no reservation. Insert the job
  // with the immutable revision/provider/plugin identity, media kind,
  // normalized request and digest for idempotent dispatch.
  const jobSize = typeof normalized.parameters.size === 'string' ? normalized.parameters.size as string : null
  const jobQuality = typeof normalized.parameters.quality === 'string' ? normalized.parameters.quality as string : null
  const jobCount = Number(normalized.parameters.count ?? 1)
  const normalizedRequestJson = JSON.stringify({ modelId: normalized.modelId, prompt: normalized.prompt, parameters: normalized.parameters, inputs: normalized.inputs, mode: normalized.mode })
  const insertSql = `INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,provider_base_url,prompt,size,quality,count,watermark,idempotency_key,provider_credential_id,provider_credential_name,optimization_mode,phase,media_kind,model_revision_id,provider_id,plugin_id,plugin_version,normalized_request,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT (created_by, idempotency_key) DO NOTHING RETURNING *`
  const insertParams = [cmd.ownerId, lockedModel.id, lockedModel.display_name, lockedModel.adapter, lockedModel.vendor_model_id, providerBaseUrl, prompt, jobSize, jobQuality, jobCount, lockedModel.watermark, idempotencyKey, credId, credName, optimizationMode, phase, mediaKind, lockedModel.revision_id || null, lockedModel.provider_id || null, lockedModel.plugin_id || null, lockedModel.plugin_version || '1.0.0', normalizedRequestJson, requestDigest]
  const inserted = await client.query(insertSql, insertParams)
  if (inserted.rows.length === 0) {
    // Concurrent create with the same idempotency key: the winner
    // already committed the job, its input bindings and outbox event.
    // Return the existing row and skip every write.
    const replayed = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [cmd.ownerId, idempotencyKey])
    if (replayed.rows[0]) return { jobId: String(replayed.rows[0].id), row: matchingExisting(replayed.rows[0]), replayed: true }
    throw new MediaServiceError('GENERATION_CREATE_FAILED', '创建生成任务失败', 503)
  }
  await attachGenerationInputs(client, cmd.ownerId, String(inserted.rows[0].id), normalizedInputs, runtimeLimits)
  if (optRow.enabled) {
    const optimization = await client.query(`INSERT INTO prompt_optimizations(job_id,created_by,input_prompt,input_language,language_model_config_id,language_model_name_snapshot,language_model_vendor_id_snapshot,language_model_protocol_snapshot,language_model_adapter_snapshot,language_model_base_url_snapshot,language_model_max_output_tokens_snapshot,language_model_temperature_snapshot,language_model_reasoning_effort_snapshot,provider_credential_id,provider_credential_name_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [inserted.rows[0].id, cmd.ownerId, prompt, cmd.inputLanguage ?? 'und', optSettings.language_model_config_id, optSettings.display_name, optSettings.vendor_model_id, optSettings.language_protocol, optSettings.adapter, optSettings.credential_base_url || optSettings.base_url, optSettings.max_output_tokens, optSettings.temperature, optSettings.reasoning_effort, optSettings.credential_id, optSettings.credential_name])
    await client.query('UPDATE generation_jobs SET prompt_optimization_id=$1 WHERE id=$2', [optimization.rows[0].id, inserted.rows[0].id])
  }
  await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key) VALUES('generation.requested',$1,$2,$3)", [inserted.rows[0].id, { jobId: inserted.rows[0].id }, `gen:${cmd.ownerId}:${idempotencyKey}`])
  return { jobId: String(inserted.rows[0].id), row: inserted.rows[0], replayed: false }
}
