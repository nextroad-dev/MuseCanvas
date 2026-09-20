import { createHash } from 'node:crypto'
import type { NextResponse } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { validateGenerationRequest, prepareRequestDigestInput } from '@musecanvas/domain'
import {
  RUNTIME_SETTINGS_DEFAULTS,
  GenerationErrorCode,
  type CreateGenerationRequest,
  type ModelCapabilities,
} from '@musecanvas/contracts'
import type { Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import {
  capabilitiesFromRow,
  defaultsFromRow,
  jobDto,
} from '../../shared/dto'
import { loadSingleJobInputs, userJobSelect } from '../../shared/pagination'
import { resolveRuntimeSettings } from '../settings/runtime'
import {
  GenerationInputError,
  attachGenerationInputs,
  validateInputsAgainstSlots,
} from '../generation-uploads'

export interface CreateGenerationJobCommand {
  actor: Actor
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
}

/**
 * The single path that turns a validated request into a queued generation.
 *
 * It used to live inline in `POST /api/generations`. `POST /api/images/edit`
 * needs the same guarantees — model revision snapshot, credential check,
 * prompt-optimization snapshot, per-user idempotency, input attach and outbox
 * enqueue in one transaction — and re-implementing any of them in a second place
 * is how an edit job ends up bypassing one. Everything that is *specific* to the
 * JSON body shape (field allowlist, legacy `size`/`quality`/`count` promotion,
 * `inputImageIds` compatibility) stays at the route; what lives here is the
 * creation contract, shared verbatim by both entry points.
 *
 * Rate limiting is deliberately the caller's job: `POST /api/generations` checks
 * the budget before it parses anything, and that position is part of the
 * behaviour. A check here would run second and count every request twice.
 */
export async function createGenerationJob(cmd: CreateGenerationJobCommand): Promise<NextResponse> {
  const { actor, modelId, normalizedInputs, idempotencyKey } = cmd

  const modelResult = await db().query(
    `SELECT m.*, rev.capabilities, rev.defaults, rev.revision FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL`,
    [modelId],
  )
  const model = modelResult.rows[0]; if (!model) return fail('MODEL_NOT_AVAILABLE', '模型当前不可用')
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
    else if (mediaKind === 'image') return fail('INVALID_INPUT', '生成参数无效')
    if (typeof cmd.legacyParameters?.quality === 'string') rawParameters.quality = cmd.legacyParameters.quality
    if (cmd.legacyParameters?.count !== undefined) rawParameters.count = Number(cmd.legacyParameters.count)
  }

  // Resolved runtime input limits (DB first) enforce both raised and
  // lowered settings; canonical defaults are the safe fallback.
  let runtimeLimits: { maxImageBytes: number; maxTotalBytes: number; maxInputs: number } = {
    maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
    maxTotalBytes: RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes,
    maxInputs: RUNTIME_SETTINGS_DEFAULTS.maxInputs,
  }
  try {
    const resolved = await resolveRuntimeSettings()
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
  // Role-aware generic inputs; each item references either an upload (`uploadId`)
  // or a gallery image (`assetId`).
  try {
    validateInputsAgainstSlots(
      normalizedInputs,
      (capabilities.inputSlots as { role: string; required?: boolean; minCount?: number; maxCount?: number }[]) || [],
      runtimeLimits,
    )
  } catch (err) {
    if (err instanceof GenerationInputError) return fail(err.code, err.message, err.status)
    return fail('INVALID_INPUT', '参考图参数无效', 400)
  }
  // Descriptor-driven validation via domain, for every media kind alike.
  //
  // Image models used to be checked here against a `{ type: 'text', maxLength: 32 }`
  // stub, on the reasoning that the provider plugin owns shape enforcement
  // downstream. What that actually bought was: `size: "9999x9999"` passed this
  // endpoint, a job row was created and queued, the plugin rejected it there,
  // and the user saw a failed task with a vendor error instead of a form error
  // naming the field they got wrong. The model's real descriptors are now the
  // single contract at this boundary too; the plugin's `validateRequest` stays
  // as the last gate before the network call, running the same code.
  //
  // An undeclared contract is refused rather than tolerated. Falling back to a
  // permissive shape is the behaviour being removed, and a model nobody has
  // described is an admin problem, not a licence to guess.
  const undeclared = capabilities.declaredBy === 'undeclared'
    || (capabilities.declaredBy === undefined && capabilities.parameters.length === 0)
  if (undeclared) {
    return fail(
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
    return fail(domainValidation.errorCode, domainValidation.errorMessage, 400, domainValidation.errors[0]?.details)
  }
  const normalized = domainValidation.value
  const prompt = normalized.prompt
  const requestDigest = createHash('sha256').update(prepareRequestDigestInput(normalized)).digest('hex')
  const attachLimits = runtimeLimits
  let row: Record<string, unknown>
  try {
    row = await transaction(async client => {
      const existing = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actor.id, idempotencyKey])
      if (existing.rows[0]) return existing.rows[0]

      // Lock model config and prompt optimization settings in generation transaction
      const lockedModelRes = await client.query(
        `SELECT m.*, rev.id AS revision_id, rev.capabilities AS revision_capabilities, rev.defaults AS revision_defaults, rev.revision AS revision_number FROM model_configs m
         LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
         WHERE m.id=$1 AND m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL FOR SHARE`,
        [modelId]
      )
      const lockedModel = lockedModelRes.rows[0]
      if (!lockedModel) throw new Error('MODEL_NOT_AVAILABLE')

      const optRes = await client.query('SELECT * FROM prompt_optimization_settings WHERE singleton=true FOR SHARE')
      const optRow = optRes.rows[0] || { singleton: true, enabled: false }

      let credId: string | null = null; let credName: string | null = null; let providerBaseUrl = lockedModel.base_url
      if (lockedModel.provider_credential_id) {
        const cred = await client.query('SELECT id, display_name, enabled, api_key_encrypted, payload_encrypted, base_url FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [lockedModel.provider_credential_id])
        if (!cred.rows[0] || !cred.rows[0].enabled || (!cred.rows[0].api_key_encrypted && !cred.rows[0].payload_encrypted)) throw new Error('PROVIDER_NOT_CONFIGURED')
        credId = cred.rows[0].id
        credName = cred.rows[0].display_name
        providerBaseUrl = cred.rows[0].base_url || lockedModel.base_url
      }

      let optSettings = optRow
      if (optRow.enabled) {
        const fullOpt = await client.query(
          `SELECT s.*,m.display_name,m.vendor_model_id,m.adapter,m.language_protocol,m.max_output_tokens,m.temperature,m.reasoning_effort,m.base_url,pc.id credential_id,pc.display_name credential_name,pc.base_url credential_base_url,pc.enabled credential_enabled,COALESCE(NULLIF(pc.payload_encrypted,''),pc.api_key_encrypted) api_key_encrypted
           FROM prompt_optimization_settings s
           LEFT JOIN model_configs m ON m.id=s.language_model_config_id AND m.deleted_at IS NULL
           LEFT JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL
           WHERE s.singleton=true`
        )
        optSettings = fullOpt.rows[0]
        if (!optSettings || !optSettings.language_model_config_id || !optSettings.language_protocol || !optSettings.credential_id || !optSettings.credential_enabled || !optSettings.api_key_encrypted) {
          throw new Error('PROMPT_MODEL_NOT_CONFIGURED')
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
      const insertParams = [actor.id, lockedModel.id, lockedModel.display_name, lockedModel.adapter, lockedModel.vendor_model_id, providerBaseUrl, prompt, jobSize, jobQuality, jobCount, lockedModel.watermark, idempotencyKey, credId, credName, optimizationMode, phase, mediaKind, lockedModel.revision_id || null, lockedModel.provider_id || null, lockedModel.plugin_id || null, lockedModel.plugin_version || '1.0.0', normalizedRequestJson, requestDigest]
      const inserted = await client.query(insertSql, insertParams)
      if (inserted.rowCount === 0) {
        // Concurrent create with the same idempotency key: the winner
        // already committed the job, its input bindings and outbox event.
        // Return the existing row and skip every write.
        const replayed = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actor.id, idempotencyKey])
        if (replayed.rows[0]) return replayed.rows[0]
        throw new Error('GENERATION_CREATE_FAILED')
      }
      await attachGenerationInputs(client, actor.id, inserted.rows[0].id, normalizedInputs, attachLimits)
      if (optRow.enabled) {
        const optimization = await client.query(`INSERT INTO prompt_optimizations(job_id,created_by,input_prompt,input_language,language_model_config_id,language_model_name_snapshot,language_model_vendor_id_snapshot,language_model_protocol_snapshot,language_model_adapter_snapshot,language_model_base_url_snapshot,language_model_max_output_tokens_snapshot,language_model_temperature_snapshot,language_model_reasoning_effort_snapshot,provider_credential_id,provider_credential_name_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [inserted.rows[0].id, actor.id, prompt, cmd.inputLanguage ?? 'und', optSettings.language_model_config_id, optSettings.display_name, optSettings.vendor_model_id, optSettings.language_protocol, optSettings.adapter, optSettings.credential_base_url || optSettings.base_url, optSettings.max_output_tokens, optSettings.temperature, optSettings.reasoning_effort, optSettings.credential_id, optSettings.credential_name])
        await client.query('UPDATE generation_jobs SET prompt_optimization_id=$1 WHERE id=$2', [optimization.rows[0].id, inserted.rows[0].id])
      }
      await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key) VALUES('generation.requested',$1,$2,$3)", [inserted.rows[0].id, { jobId: inserted.rows[0].id }, `gen:${actor.id}:${idempotencyKey}`])
      return inserted.rows[0]
    })
  } catch (error) {
    if (error instanceof GenerationInputError) return fail(error.code, error.message, error.status)
    if (error instanceof Error && error.message === 'MODEL_NOT_AVAILABLE') {
      return fail('MODEL_NOT_AVAILABLE', '模型当前不可用', 409)
    }
    const code = error instanceof Error && ['PROVIDER_NOT_CONFIGURED', 'PROMPT_MODEL_NOT_CONFIGURED'].includes(error.message) ? error.message : 'GENERATION_CREATE_FAILED'
    return fail(code, code === 'PROMPT_MODEL_NOT_CONFIGURED' ? '提示词优化模型配置不完整' : code === 'PROVIDER_NOT_CONFIGURED' ? '生成供应商凭据未配置' : '创建生成任务失败', 503)
  }
  const responseRow = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [row.id, actor.id])
  const jobInputs = await loadSingleJobInputs(db(), row.id as string)
  return ok(await jobDto(responseRow.rows[0] || row, [], jobInputs), { status: 202 })
}
