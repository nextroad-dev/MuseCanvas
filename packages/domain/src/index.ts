import type {
  CreateGenerationRequest,
  EnumParameterDescriptor,
  GenerationInputItem,
  GenerationInputRole,
  GenerationMode,
  GenerationOutput,
  ImageGenerationMetadata,
  ImageGenerationOutput,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MediaKind,
  ModelCapabilities,
  ModelKind,
  ParameterCrossFieldConstraint,
  ParameterDescriptor,
  ParameterErrorDetails,
  TextParameterDescriptor,
  VideoGenerationMetadata,
  VideoGenerationOutput,
} from '@musecanvas/contracts'
import {
  evaluateCrossFieldConstraints,
  isParameterVisible,
  validateParameterValue,
} from '@musecanvas/contracts'

export type {
  CreateGenerationRequest,
  EnumParameterDescriptor,
  GenerationInputItem,
  GenerationInputRole,
  GenerationMode,
  GenerationOutput,
  ImageGenerationMetadata,
  ImageGenerationOutput,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MediaKind,
  ModelCapabilities,
  ModelKind,
  ParameterDescriptor,
  TextParameterDescriptor,
  VideoGenerationMetadata,
  VideoGenerationOutput,
}

// ---------------------------------------------------------------------------
// Legacy & Existing Job Status & Validation (Preserved)
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled'
export const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'canceled'])

// ---------------------------------------------------------------------------
// Error Handling & Validation Types
// ---------------------------------------------------------------------------

export class GenerationValidationError extends Error {
  readonly code: string
  readonly field?: string
  readonly details?: unknown

  constructor(code: string, message: string, field?: string, details?: unknown) {
    super(message)
    this.name = 'GenerationValidationError'
    this.code = code
    this.field = field
    this.details = details
  }
}

export interface ValidationErrorItem {
  code: string
  message: string
  field?: string
  /**
   * Which parameter, with what value, broke which rule. The response envelope
   * forwards this so the console can mark the offending control red instead of
   * showing the user a sentence about a form they have already filled in.
   */
  details?: ParameterErrorDetails
}

export interface ValidationSuccess<T> {
  valid: true
  value: T
  errors?: never
}

export interface ValidationFailure {
  valid: false
  value?: never
  errors: ValidationErrorItem[]
  errorCode: string
  errorMessage: string
}

export type ValidationOutcome<T> = ValidationSuccess<T> | ValidationFailure

// `ParameterCrossFieldConstraint` is declared in `@musecanvas/contracts` and
// re-exported here rather than restated: the browser has to evaluate the exact
// same combination rules to disable the submit button, and two definitions of
// "is this pair legal" is the drift this move removes. Re-exporting keeps every
// existing `import { ParameterCrossFieldConstraint } from '@musecanvas/domain'`
// call site compiling unchanged.
export type { ParameterCrossFieldConstraint }

/**
 * The validator's view of a model.
 *
 * This used to be `ModelCapabilities` plus a domain-only `constraints` field.
 * Cross-field rules now live in the shared contract as `crossFieldConstraints`,
 * so there is exactly one field name that the browser, this validator and the
 * plugin adapters read — and one place a rule can be declared. The alias is kept
 * because it names a role (`ModelValidationConfig` describes the argument) that
 * the more general type does not.
 */
export type ModelValidationConfig = ModelCapabilities

export interface NormalizedGenerationRequest {
  modelId: string
  prompt: string
  parameters: Record<string, JsonValue>
  inputs: GenerationInputItem[]
  mode: GenerationMode
  idempotencyKey?: string
  inputLanguage?: string
}

// ---------------------------------------------------------------------------
// Descriptor-Driven Request Validation & Normalization
// ---------------------------------------------------------------------------

export function validateGenerationRequest(
  capabilities: ModelValidationConfig,
  request: CreateGenerationRequest,
  options?: { defaults?: Record<string, JsonValue> },
): ValidationOutcome<NormalizedGenerationRequest> {
  const errors: ValidationErrorItem[] = []

  // 1. ModelId & Prompt validation
  if (!request.modelId || typeof request.modelId !== 'string' || request.modelId.trim() === '') {
    errors.push({
      code: 'INVALID_MODEL_ID',
      message: 'Model ID must be a non-empty string',
      field: 'modelId',
    })
  }

  if (typeof request.prompt !== 'string') {
    errors.push({
      code: 'INVALID_PROMPT',
      message: 'Prompt must be a string',
      field: 'prompt',
    })
  }

  const trimmedPrompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''

  // 2. Parameters descriptor validation & unknown parameter rejection
  const rawParameters = request.parameters || {}
  if (typeof rawParameters !== 'object' || rawParameters === null || Array.isArray(rawParameters)) {
    errors.push({
      code: 'INVALID_PARAMETERS',
      message: 'Parameters must be an object',
      field: 'parameters',
    })
  }

  const descriptorMap = new Map<string, ParameterDescriptor>()
  for (const descriptor of capabilities.parameters) {
    descriptorMap.set(descriptor.name, descriptor)
  }

  // Reject unknown parameters
  for (const key of Object.keys(rawParameters)) {
    if (!descriptorMap.has(key)) {
      errors.push({
        code: 'UNKNOWN_PARAMETER',
        message: `Unknown parameter '${key}' is not supported by model capabilities`,
        field: `parameters.${key}`,
      })
    }
  }

  const normalizedParameters: Record<string, JsonValue> = {}

  // Validate each parameter against its descriptor, then the combination rules
  // over what survived. Both calls are the shared contract validators, so the
  // browser's "may I submit this", this authoritative gate, and the plugin
  // adapter's pre-flight check are one implementation rather than three that can
  // disagree about what a size means.
  for (const descriptor of capabilities.parameters) {
    const rawVal = rawParameters[descriptor.name]
    const defaultVal = options?.defaults?.[descriptor.name] ?? descriptor.defaultValue

    // `dependsOn` gates the whole parameter, including its default: a control
    // the model only offers under another value must stay out of the request
    // entirely. Checking after the absent-value branch would still materialise
    // `output_compression: 100` behind a hidden control, and a parameter nobody
    // can see or unset has no business reaching a vendor.
    if (descriptor.dependsOn && !isParameterVisible(descriptor, rawParameters)) continue

    if (rawVal === undefined || rawVal === null) {
      if (defaultVal !== undefined) {
        normalizedParameters[descriptor.name] = defaultVal
      } else if (descriptor.required) {
        errors.push({
          code: 'MISSING_REQUIRED_PARAMETER',
          message: `Missing required parameter '${descriptor.name}'`,
          field: `parameters.${descriptor.name}`,
        })
      }
      continue
    }

    const issues = validateParameterValue(descriptor, rawVal)
    if (issues.length === 0) {
      normalizedParameters[descriptor.name] = rawVal
      continue
    }
    for (const issue of issues) {
      errors.push({
        code: issue.code,
        message: issue.message,
        field: `parameters.${issue.parameter}`,
        details: {
          parameter: issue.parameter,
          value: issue.value as JsonValue | undefined,
          constraint: issue.constraint,
        },
      })
    }
  }

  // 3. Cross-field constraints validation. Evaluated over the normalized set, so
  // a defaulted value participates in a rule the same way an explicit one does.
  for (const issue of evaluateCrossFieldConstraints(
    capabilities.crossFieldConstraints,
    normalizedParameters,
  )) {
    errors.push({
      code: issue.code,
      message: issue.message,
      field: `parameters.${issue.parameter}`,
      details: {
        parameter: issue.parameter,
        value: issue.value as JsonValue | undefined,
        constraint: issue.constraint,
      },
    })
  }

  // 4. Ordered Input Slots validation
  const rawInputs = request.inputs || []
  if (!Array.isArray(rawInputs)) {
    errors.push({
      code: 'INVALID_INPUTS',
      message: 'Inputs must be an array of items',
      field: 'inputs',
    })
  }

  const slotMap = new Map<string, InputSlotDescriptor>()
  for (const slot of capabilities.inputSlots) {
    slotMap.set(slot.role, slot)
  }

  const seenPositions = new Set<number>()
  /** Dedupe key per input reference: `u:<uploadId>` or `a:<assetId>`. Two refs of
   *  different kinds never collide, and the same asset may still feed *other* jobs
   *  — this set is scoped to one request only. */
  const seenRefs = new Set<string>()
  const inputsByRole = new Map<string, GenerationInputItem[]>()

  for (let i = 0; i < rawInputs.length; i++) {
    const item = rawInputs[i]
    if (!item || typeof item !== 'object') {
      errors.push({
        code: 'INVALID_INPUT_ITEM',
        message: `Input at index ${i} is not an object`,
        field: `inputs[${i}]`,
      })
      continue
    }

    // An input carries exactly one reference: an upload (bytes the browser streamed
    // in, owned by this job) or a gallery asset (referenced, never copied). Both on
    // one item has no coherent lifecycle, and neither leaves the slot unfillable.
    const uploadId = typeof item.uploadId === 'string' ? item.uploadId.trim() : ''
    const assetId = typeof item.assetId === 'string' ? item.assetId.trim() : ''
    if (uploadId && assetId) {
      errors.push({
        code: 'INVALID_INPUT_REF',
        message: `Input at index ${i} cannot carry both uploadId and assetId`,
        field: `inputs[${i}].assetId`,
      })
    } else if (!uploadId && !assetId) {
      errors.push({
        code: 'INVALID_INPUT_UPLOAD_ID',
        message: `Input at index ${i} must have exactly one of uploadId or assetId`,
        field: `inputs[${i}].uploadId`,
      })
    } else {
      // `u:`/`a:` prefixes keep the two id spaces apart; the set is per request, so
      // reusing one asset across different jobs stays allowed.
      const refKey = uploadId ? `u:${uploadId}` : `a:${assetId}`
      if (seenRefs.has(refKey)) {
        errors.push({
          code: 'DUPLICATE_INPUT_REF',
          message: `Input at index ${i} repeats an image already present in inputs`,
          field: `inputs[${i}]`,
        })
      }
      seenRefs.add(refKey)
    }

    if (!item.role || typeof item.role !== 'string') {
      errors.push({
        code: 'INVALID_INPUT_ROLE',
        message: `Input at index ${i} must have a valid role`,
        field: `inputs[${i}].role`,
      })
      continue
    }

    if (!slotMap.has(item.role)) {
      errors.push({
        code: 'UNKNOWN_INPUT_ROLE',
        message: `Input role '${item.role}' is not supported by model input slots`,
        field: `inputs[${i}].role`,
      })
    }

    if (typeof item.position !== 'number' || !Number.isInteger(item.position) || item.position < 0) {
      errors.push({
        code: 'INVALID_INPUT_POSITION',
        message: `Input at index ${i} position must be a non-negative integer`,
        field: `inputs[${i}].position`,
      })
    } else {
      if (seenPositions.has(item.position)) {
        errors.push({
          code: 'DUPLICATE_INPUT_POSITION',
          message: `Duplicate input position ${item.position}`,
          field: `inputs[${i}].position`,
        })
      }
      seenPositions.add(item.position)
    }

    const roleList = inputsByRole.get(item.role) || []
    roleList.push(item)
    inputsByRole.set(item.role, roleList)
  }

  // Verify input slot counts & requirements
  for (const slot of capabilities.inputSlots) {
    const items = inputsByRole.get(slot.role) || []
    const count = items.length

    if (slot.required && count === 0) {
      errors.push({
        code: 'MISSING_REQUIRED_INPUT',
        message: `Missing required input for slot role '${slot.role}'`,
        field: `inputs.${slot.role}`,
      })
    } else if (count < slot.minCount) {
      errors.push({
        code: 'INPUT_COUNT_TOO_LOW',
        message: `Input count for role '${slot.role}' (${count}) is below minimum (${slot.minCount})`,
        field: `inputs.${slot.role}`,
      })
    } else if (count > slot.maxCount) {
      errors.push({
        code: 'INPUT_COUNT_EXCEEDED',
        message: `Input count for role '${slot.role}' (${count}) exceeds maximum allowed (${slot.maxCount})`,
        field: `inputs.${slot.role}`,
      })
    }
  }

  // Sort inputs by position ascending
  const sortedInputs = [...rawInputs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  // 5. Generation Mode Resolution & Verification
  const hasInputs = sortedInputs.length > 0
  const isVideoCapabilities =
    capabilities.supportedMediaKinds?.includes('video') ||
    capabilities.modes.some((m) => m === 'text_to_video' || m === 'image_to_video')

  let resolvedMode: GenerationMode
  if (!hasInputs) {
    if (isVideoCapabilities) {
      resolvedMode = 'text_to_video'
    } else {
      resolvedMode = 'text_to_image'
    }
  } else {
    if (isVideoCapabilities) {
      resolvedMode = 'image_to_video'
    } else {
      resolvedMode = 'image_to_image'
    }
  }

  if (!capabilities.modes.includes(resolvedMode)) {
    // If the standard derived mode isn't supported, fall back to first compatible supported mode
    const fallback = capabilities.modes[0]
    if (fallback) {
      resolvedMode = fallback
    } else {
      errors.push({
        code: 'UNSUPPORTED_GENERATION_MODE',
        message: `Mode '${resolvedMode}' is not supported by model capabilities`,
        field: 'mode',
      })
    }
  }

  // 6. Prompt requirement based on mode
  if (trimmedPrompt.length === 0 && (resolvedMode === 'text_to_image' || resolvedMode === 'text_to_video')) {
    errors.push({
      code: 'EMPTY_PROMPT',
      message: `Prompt cannot be empty for mode '${resolvedMode}'`,
      field: 'prompt',
    })
  }

  // 7. Max count validation if count is in parameters
  if (normalizedParameters.count !== undefined) {
    const countVal = normalizedParameters.count
    if (typeof countVal === 'number' && capabilities.maxCount !== undefined && countVal > capabilities.maxCount) {
      errors.push({
        code: 'INVALID_COUNT',
        message: `Count ${countVal} exceeds model maximum count ${capabilities.maxCount}`,
        field: 'parameters.count',
      })
    }
  }

  if (errors.length > 0) {
    const first = errors[0]
    return {
      valid: false,
      errors,
      errorCode: first.code,
      errorMessage: first.message,
    }
  }

  return {
    valid: true,
    value: {
      modelId: request.modelId,
      prompt: trimmedPrompt,
      parameters: normalizedParameters,
      inputs: sortedInputs,
      mode: resolvedMode,
      idempotencyKey: request.idempotencyKey,
      inputLanguage: request.inputLanguage,
    },
  }
}

export function normalizeGenerationRequest(
  capabilities: ModelValidationConfig,
  request: CreateGenerationRequest,
  options?: { defaults?: Record<string, JsonValue> },
): NormalizedGenerationRequest {
  const result = validateGenerationRequest(capabilities, request, options)
  if (!result.valid) {
    throw new GenerationValidationError(result.errorCode, result.errorMessage, result.errors[0]?.field, result.errors)
  }
  return result.value
}

// ---------------------------------------------------------------------------
// Canonical Request Serialization & Digest Input Preparation
// ---------------------------------------------------------------------------

export function serializeCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serializeCanonicalJson).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of sortedKeys) {
    const v = obj[key]
    if (v !== undefined) {
      parts.push(JSON.stringify(key) + ':' + serializeCanonicalJson(v))
    }
  }
  return '{' + parts.join(',') + '}'
}

export function serializeCanonicalGenerationRequest(
  request: NormalizedGenerationRequest | CreateGenerationRequest,
): string {
  const sortedInputs = [...(request.inputs || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const canonicalObj = {
    idempotencyKey: request.idempotencyKey || undefined,
    inputLanguage: request.inputLanguage || undefined,
    inputs: sortedInputs.map((i) => ({
      position: i.position,
      role: i.role,
      uploadId: i.uploadId,
      // `serializeCanonicalJson` skips undefined keys, so upload-only requests keep
      // hashing to exactly the pre-assetId bytes. Omitting this field instead makes
      // two different gallery picks share one digest — and one idempotency key.
      assetId: i.assetId,
    })),
    modelId: request.modelId,
    parameters: request.parameters || {},
    prompt: typeof request.prompt === 'string' ? request.prompt.trim() : '',
  }
  return serializeCanonicalJson(canonicalObj)
}

export function prepareRequestDigestInput(
  request: NormalizedGenerationRequest | CreateGenerationRequest,
): string {
  return serializeCanonicalGenerationRequest(request)
}
