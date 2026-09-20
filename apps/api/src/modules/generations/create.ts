import { randomUUID } from 'node:crypto'
import { fail } from '../../shared/http'
import { limited } from '../../shared/redis'
import { GenerationInputError, normalizeGenerationInputs } from '../generation-uploads'
import type { AuthedContext } from '../../router/types'
import { createGenerationJob } from './create-job'

/**
 * `POST /api/generations` — the JSON boundary.
 *
 * Everything here is about the *shape of the request body*, which only this
 * endpoint has: the field allowlist, the prompt sanity checks, the
 * `parameters`-versus-legacy-flat-fields choice, the `inputImageIds`
 * compatibility path, and the idempotency key resolution from header or body.
 *
 * What happens once those are settled — model snapshot, credential check,
 * descriptor validation, the job row, input attach and the outbox event — is the
 * shared creation contract in `create-job.ts`, because `POST /api/images/edit`
 * must not get a second, slightly different copy of those guarantees.
 */

const ALLOWED_GENERATION_FIELDS = new Set(['prompt', 'modelId', 'parameters', 'inputs', 'idempotencyKey', 'inputLanguage', 'size', 'quality', 'count', 'inputImageIds'])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const hasControlChars = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) || 0
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

export async function createGeneration(context: AuthedContext) {
  const { actor, request } = context
  // First, before any parsing: this is the position it has always held, and a
  // request over budget is refused without being inspected.
  if (await limited(`gen:create:${actor.id}`, 20, 300)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const input = await context.json()

  if (Object.keys(input).some(key => !ALLOWED_GENERATION_FIELDS.has(key))) return fail('INVALID_INPUT', '生成请求包含不允许的字段')
  if (typeof input.prompt !== 'string' || input.prompt.trim().length < 1 || input.prompt.length > 4000 || hasControlChars(input.prompt) || typeof input.modelId !== 'string') return fail('INVALID_INPUT', '生成参数无效')
  if (!UUID_PATTERN.test(input.modelId)) return fail('INVALID_INPUT', '模型参数无效')
  // The unified `parameters` object must be an object; the legacy path is only
  // reached when it is absent altogether.
  if (input.parameters !== undefined && (typeof input.parameters !== 'object' || input.parameters === null || Array.isArray(input.parameters))) {
    return fail('INVALID_INPUT', '生成参数无效')
  }

  // Role-aware generic inputs with legacy inputImageIds compatibility. Each item
  // references either an upload (`uploadId`) or a gallery image (`assetId`).
  // Slot validation itself happens in the contract, once the model's declared
  // input slots and the runtime limits are known.
  let normalizedInputs
  try {
    normalizedInputs = normalizeGenerationInputs(input.inputs, input.inputImageIds)
  } catch (err) {
    if (err instanceof GenerationInputError) return fail(err.code, err.message, err.status)
    return fail('INVALID_INPUT', '参考图参数无效', 400)
  }

  return createGenerationJob({
    actor,
    modelId: input.modelId as string,
    prompt: input.prompt as string,
    parameters: input.parameters as Record<string, unknown> | undefined,
    legacyParameters: { size: input.size, quality: input.quality, count: input.count },
    normalizedInputs,
    idempotencyKey: request.headers.get('idempotency-key') || (typeof input.idempotencyKey === 'string' ? input.idempotencyKey : randomUUID()),
    inputLanguage: typeof input.inputLanguage === 'string' ? (input.inputLanguage as string).slice(0, 20) : undefined,
  })
}
