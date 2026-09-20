import type { PoolClient } from 'pg'

import { validateGenerationRequest } from '@musecanvas/domain'
import {
  GenerationErrorCode,
  type CreateGenerationRequest,
  type JsonValue,
  type ModelCapabilities,
  type ParameterErrorDetails,
} from '@musecanvas/contracts'
import { capabilitiesFromRow, defaultsFromRow } from '../shared/dto'

/**
 * Re-validation on a manual retry.
 *
 * Retrying is a resubmit, so it is checked like one: a parameter set that would
 * not pass `POST /generations` must not re-enter the queue either.
 *
 * The contract used is the one the job is *pinned* to, falling back to the
 * model's latest revision for rows created before revisions existed. That
 * distinction is what makes this safe to turn on. Validating old work against a
 * contract written after it would reject jobs the worker is still going to run
 * correctly against their own pinned plugin — a tightened schema would silently
 * turn history into undeliverable rows. Validating against the pinned revision
 * catches the case that actually needs catching: stored parameters that never
 * satisfied any contract, from a hand-built row or a bug since fixed.
 */
export type RetryValidation =
  | { ok: true }
  | { ok: false; code: string; message: string; status: number; details?: ParameterErrorDetails }

/** The failure arm, for callers that hold a rejection across a closure boundary. */
export type RetryRejection = Extract<RetryValidation, { ok: false }>

const UNDECLARED_MESSAGE = '该模型尚未声明参数契约，无法校验历史生成参数，请重新创建任务'

export async function validateRetryRequest(
  client: PoolClient,
  job: {
    id: string
    modelId: string
    /** `generation_jobs.model_revision_id`, nullable on pre-revision rows. */
    revisionId: string | null
    /** The stored `normalized_request` jsonb. */
    normalizedRequest: unknown
  },
): Promise<RetryValidation> {
  const stored = asRecord(job.normalizedRequest)
  const parameters = asRecord(stored?.parameters) ?? {}
  const inputs = Array.isArray(stored?.inputs) ? (stored.inputs as CreateGenerationRequest['inputs']) : []

  // One query, and the revision is chosen rather than assumed: the pinned row
  // when it still exists, otherwise whatever the model now publishes.
  const loaded = await client.query(
    `SELECT m.model_kind, m.sizes, m.quality_options, m.max_count, m.max_input_images,
            COALESCE(pinned.capabilities, rev.capabilities) AS capabilities,
            COALESCE(pinned.defaults, rev.defaults) AS defaults
     FROM model_configs m
     LEFT JOIN model_config_revisions pinned ON pinned.id = $2
     LEFT JOIN model_config_revisions rev ON rev.id = m.latest_revision_id
     WHERE m.id=$1 AND m.deleted_at IS NULL AND m.enabled=true`,
    [job.modelId, job.revisionId],
  ).catch(() => null)
  const row = loaded?.rows?.[0] as Record<string, unknown> | undefined
  if (!row) {
    return {
      ok: false,
      code: 'MODEL_NOT_AVAILABLE',
      message: '该任务绑定的模型已不可用，请重新创建任务',
      status: 409,
    }
  }

  const capabilities = capabilitiesFromRow(row)
  const declared = capabilities.declaredBy
  if (declared === 'undeclared' || (declared === undefined && capabilities.parameters.length === 0)) {
    return { ok: false, code: GenerationErrorCode.MODEL_CAPABILITIES_UNDECLARED, message: UNDECLARED_MESSAGE, status: 409 }
  }

  const result = validateGenerationRequest(
    capabilities as unknown as ModelCapabilities,
    {
      modelId: job.modelId,
      prompt: typeof stored?.prompt === 'string' ? stored.prompt : '',
      parameters: parameters as Record<string, JsonValue>,
      inputs,
      idempotencyKey: `retry:${job.id}`,
    },
    { defaults: (defaultsFromRow(row) ?? {}) as Record<string, JsonValue> },
  )

  if (result.valid) return { ok: true }
  return {
    ok: false,
    code: result.errorCode,
    message: result.errorMessage,
    status: 400,
    details: result.errors[0]?.details,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
