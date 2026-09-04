import type {
  CreateGenerationRequest,
  EnumParameterDescriptor,
  GenerationInputItem,
  GenerationInputRole,
  GenerationMode,
  GenerationOutput,
  ImageGenerationMetadata,
  ImageGenerationOutput,
  ImagePricingV1,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MediaCreditsQuote,
  MediaKind,
  ModelCapabilities,
  ModelKind,
  ModelPricing,
  ParameterDescriptor,
  PricingScheme,
  QuoteMediaGenerationCreditsInput,
  TextParameterDescriptor,
  VideoGenerationMetadata,
  VideoGenerationOutput,
  VideoPricingV1,
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
  ImagePricingV1,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MediaCreditsQuote,
  MediaKind,
  ModelCapabilities,
  ModelKind,
  ModelPricing,
  ParameterDescriptor,
  PricingScheme,
  QuoteMediaGenerationCreditsInput,
  TextParameterDescriptor,
  VideoGenerationMetadata,
  VideoGenerationOutput,
  VideoPricingV1,
}

// ---------------------------------------------------------------------------
// Legacy & Existing Job Status & Validation (Preserved)
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled'
export const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'canceled'])

const qualityOptions = new Set(['auto', 'low', 'medium', 'high'])
const sizeBands = new Set(['2K', '3K', '4K'])
const SEEDREAM_MAX_ASPECT_RATIO = 16
const seedreamRules = {
  '4.0': { minPixels: 1280 * 720, maxPixels: 4096 * 4096 },
  '4.5': { minPixels: 2560 * 1440, maxPixels: 4096 * 4096 },
  '5.0-lite': { minPixels: 2560 * 1440, maxPixels: 10_404_496 },
}

function seedreamRule(vendorModelId?: string) {
  const id = (vendorModelId || '').toLowerCase()
  if ((id.includes('5-0') || id.includes('5.0')) && id.includes('lite')) return seedreamRules['5.0-lite']
  if (id.includes('4-5') || id.includes('4.5')) return seedreamRules['4.5']
  return seedreamRules['4.0']
}

function exactDimensions(size: string): { width: number; height: number } | null {
  const match = size.match(/^([1-9]\d*)x([1-9]\d*)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { width, height } : null
}

function seedreamSizeValid(size: string, vendorModelId?: string): boolean {
  const dimensions = exactDimensions(size)
  if (!dimensions) return false
  const { width, height } = dimensions
  const pixels = width * height
  const aspectRatio = Math.max(width / height, height / width)
  const rule = seedreamRule(vendorModelId)
  return pixels >= rule.minPixels && pixels <= rule.maxPixels && aspectRatio <= SEEDREAM_MAX_ASPECT_RATIO
}

function sizeValid(model: { adapter: string; vendorModelId?: string }, size: string): boolean {
  if (model.adapter === 'seedream') return seedreamSizeValid(size, model.vendorModelId)
  if (sizeBands.has(size)) return true
  const dimensions = exactDimensions(size)
  if (!dimensions) return false
  const { width, height } = dimensions
  return width >= 256 && width <= 4096 && height >= 256 && height <= 4096 && width * height <= 4096 * 4096
}

export function validateModelInput(
  model: {
    adapter: string
    vendorModelId?: string
    sizes: string[]
    qualityOptions: string[]
    maxCount: number
  },
  input: { size: string; quality?: string; count: number },
): string | null {
  if (!sizeValid(model, input.size)) return 'INVALID_SIZE'
  const maxCount = Math.min(4, Math.max(1, model.maxCount || 1))
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > maxCount) return 'INVALID_COUNT'
  if (input.quality && !qualityOptions.has(input.quality)) return 'INVALID_QUALITY'
  return null
}

// ---------------------------------------------------------------------------
// Safe Credits Validation & Legacy Quoting (Preserved)
// ---------------------------------------------------------------------------

export const MAX_SAFE_CREDITS = Number.MAX_SAFE_INTEGER

export function validateSafeCredits(amount: unknown): amount is number {
  return (
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    Number.isInteger(amount) &&
    amount >= 0 &&
    amount <= Number.MAX_SAFE_INTEGER
  )
}

export const isSafeCreditAmount = validateSafeCredits

export function assertSafeCredits(amount: unknown, label = 'credit amount'): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError(`${label} must be a finite number`)
  }
  if (!Number.isInteger(amount)) {
    throw new RangeError(`${label} must be an integer`)
  }
  if (amount < 0) {
    throw new RangeError(`${label} must be non-negative`)
  }
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds maximum safe integer`)
  }
}

export interface QuoteGenerationCreditsInput {
  creditsPerImage: number
  count: number
  optimizationCredits?: number
}

export interface GenerationCreditsQuote {
  creditsPerImage: number
  count: number
  optimizationCredits: number
  imageCredits: number
  totalCredits: number
  quotedCredits: number
}

export function quoteGenerationCredits(
  inputOrCreditsPerImage: QuoteGenerationCreditsInput | number,
  maybeCount?: number,
  maybeOptimizationCredits?: number,
): GenerationCreditsQuote {
  let creditsPerImage: number
  let count: number
  let optimizationCredits: number

  if (typeof inputOrCreditsPerImage === 'object' && inputOrCreditsPerImage !== null) {
    creditsPerImage = inputOrCreditsPerImage.creditsPerImage
    count = inputOrCreditsPerImage.count
    optimizationCredits = inputOrCreditsPerImage.optimizationCredits ?? 0
  } else {
    creditsPerImage = inputOrCreditsPerImage
    count = maybeCount!
    optimizationCredits = maybeOptimizationCredits ?? 0
  }

  assertSafeCredits(creditsPerImage, 'creditsPerImage')

  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new TypeError('count must be a finite number')
  }
  if (!Number.isInteger(count)) {
    throw new RangeError('count must be an integer')
  }
  if (count < 1) {
    throw new RangeError('count must be at least 1')
  }
  if (count > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('count exceeds maximum safe integer')
  }

  assertSafeCredits(optimizationCredits, 'optimizationCredits')

  if (creditsPerImage > 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / creditsPerImage)) {
    throw new RangeError('image credits calculation exceeds safe integer limit')
  }

  const imageCredits = creditsPerImage * count

  if (Number.MAX_SAFE_INTEGER - imageCredits < optimizationCredits) {
    throw new RangeError('total credits calculation exceeds safe integer limit')
  }

  const totalCredits = imageCredits + optimizationCredits

  return {
    creditsPerImage,
    count,
    optimizationCredits,
    imageCredits,
    totalCredits,
    quotedCredits: totalCredits,
  }
}

// ---------------------------------------------------------------------------
// Media Pricing Quoting (Unified Image & Video with Safe-Integer Checks)
// ---------------------------------------------------------------------------

export function quoteMediaGenerationCredits(
  input: QuoteMediaGenerationCreditsInput,
): MediaCreditsQuote {
  const { pricing, count: rawCount, durationSeconds: rawDuration, optimizationCredits: rawOpt } = input

  const count = rawCount ?? 1
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new TypeError('count must be a finite number')
  }
  if (!Number.isInteger(count)) {
    throw new RangeError('count must be an integer')
  }
  if (count < 1) {
    throw new RangeError('count must be at least 1')
  }
  if (count > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('count exceeds maximum safe integer')
  }

  const optimizationCredits = rawOpt ?? 0
  assertSafeCredits(optimizationCredits, 'optimizationCredits')

  let baseCredits = 0
  let durationSeconds: number | undefined

  if (pricing.scheme === 'per_image_v1') {
    assertSafeCredits(pricing.creditsPerImage, 'creditsPerImage')
    if (pricing.creditsPerImage > 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / pricing.creditsPerImage)) {
      throw new RangeError('image credits calculation exceeds safe integer limit')
    }
    baseCredits = pricing.creditsPerImage * count
  } else if (pricing.scheme === 'per_second_v1') {
    assertSafeCredits(pricing.creditsPerSecond, 'creditsPerSecond')
    durationSeconds = rawDuration ?? (pricing.minDurationSeconds ?? 1)
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
      throw new TypeError('durationSeconds must be a finite number')
    }
    if (!Number.isInteger(durationSeconds)) {
      throw new RangeError('durationSeconds must be an integer')
    }
    if (durationSeconds < 1) {
      throw new RangeError('durationSeconds must be at least 1')
    }
    if (pricing.minDurationSeconds !== undefined && durationSeconds < pricing.minDurationSeconds) {
      throw new RangeError(`durationSeconds must be at least ${pricing.minDurationSeconds}`)
    }
    if (pricing.maxDurationSeconds !== undefined && durationSeconds > pricing.maxDurationSeconds) {
      throw new RangeError(`durationSeconds must be at most ${pricing.maxDurationSeconds}`)
    }

    if (pricing.creditsPerSecond > 0 && durationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / pricing.creditsPerSecond)) {
      throw new RangeError('video credits calculation exceeds safe integer limit')
    }
    const perOutputCredits = pricing.creditsPerSecond * durationSeconds
    if (perOutputCredits > 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / perOutputCredits)) {
      throw new RangeError('video credits calculation exceeds safe integer limit')
    }
    baseCredits = perOutputCredits * count
  } else {
    throw new Error('Unsupported pricing scheme')
  }

  if (Number.MAX_SAFE_INTEGER - baseCredits < optimizationCredits) {
    throw new RangeError('total credits calculation exceeds safe integer limit')
  }

  const totalCredits = baseCredits + optimizationCredits

  return {
    pricing,
    count,
    durationSeconds,
    baseCredits,
    optimizationCredits,
    totalCredits,
    quotedCredits: totalCredits,
  }
}

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

export interface ParameterCrossFieldConstraint {
  type: 'requires' | 'forbidden' | 'mutually_exclusive' | 'max_product'
  parameter: string
  targetParameter?: string
  parameters?: [string, string]
  whenValueEquals?: JsonValue
  maxProduct?: number
  message?: string
}

export interface ModelValidationConfig extends ModelCapabilities {
  constraints?: ParameterCrossFieldConstraint[]
}

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

  // Validate each parameter against descriptor
  for (const descriptor of capabilities.parameters) {
    const rawVal = rawParameters[descriptor.name]
    const defaultVal = options?.defaults?.[descriptor.name] ?? descriptor.defaultValue

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

    // Validate type and bounds
    switch (descriptor.type) {
      case 'enum': {
        if (typeof rawVal !== 'string') {
          errors.push({
            code: 'INVALID_PARAMETER_TYPE',
            message: `Parameter '${descriptor.name}' must be a string`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (!descriptor.options.includes(rawVal)) {
          errors.push({
            code: 'INVALID_PARAMETER_VALUE',
            message: `Parameter '${descriptor.name}' value '${rawVal}' is not in allowed options: [${descriptor.options.join(', ')}]`,
            field: `parameters.${descriptor.name}`,
          })
        } else {
          normalizedParameters[descriptor.name] = rawVal
        }
        break
      }

      case 'integer': {
        if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || !Number.isInteger(rawVal)) {
          errors.push({
            code: 'INVALID_PARAMETER_TYPE',
            message: `Parameter '${descriptor.name}' must be a safe integer`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (rawVal < Number.MIN_SAFE_INTEGER || rawVal > Number.MAX_SAFE_INTEGER) {
          errors.push({
            code: 'PARAMETER_OUT_OF_RANGE',
            message: `Parameter '${descriptor.name}' must be within safe integer bounds`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.min !== undefined && rawVal < descriptor.min) {
          errors.push({
            code: 'PARAMETER_OUT_OF_RANGE',
            message: `Parameter '${descriptor.name}' must be >= ${descriptor.min}`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.max !== undefined && rawVal > descriptor.max) {
          errors.push({
            code: 'PARAMETER_OUT_OF_RANGE',
            message: `Parameter '${descriptor.name}' must be <= ${descriptor.max}`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.step !== undefined && descriptor.step > 0) {
          const base = descriptor.min ?? 0
          if ((rawVal - base) % descriptor.step !== 0) {
            errors.push({
              code: 'PARAMETER_STEP_MISMATCH',
              message: `Parameter '${descriptor.name}' must align with step ${descriptor.step}`,
              field: `parameters.${descriptor.name}`,
            })
          } else {
            normalizedParameters[descriptor.name] = rawVal
          }
        } else {
          normalizedParameters[descriptor.name] = rawVal
        }
        break
      }

      case 'boolean': {
        if (typeof rawVal !== 'boolean') {
          errors.push({
            code: 'INVALID_PARAMETER_TYPE',
            message: `Parameter '${descriptor.name}' must be a boolean`,
            field: `parameters.${descriptor.name}`,
          })
        } else {
          normalizedParameters[descriptor.name] = rawVal
        }
        break
      }

      case 'text': {
        if (typeof rawVal !== 'string') {
          errors.push({
            code: 'INVALID_PARAMETER_TYPE',
            message: `Parameter '${descriptor.name}' must be a string`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.minLength !== undefined && rawVal.length < descriptor.minLength) {
          errors.push({
            code: 'TEXT_TOO_SHORT',
            message: `Parameter '${descriptor.name}' length must be >= ${descriptor.minLength}`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.maxLength !== undefined && rawVal.length > descriptor.maxLength) {
          errors.push({
            code: 'TEXT_TOO_LONG',
            message: `Parameter '${descriptor.name}' length must be <= ${descriptor.maxLength}`,
            field: `parameters.${descriptor.name}`,
          })
        } else if (descriptor.pattern !== undefined && !new RegExp(descriptor.pattern).test(rawVal)) {
          errors.push({
            code: 'TEXT_PATTERN_MISMATCH',
            message: `Parameter '${descriptor.name}' does not match required pattern ${descriptor.pattern}`,
            field: `parameters.${descriptor.name}`,
          })
        } else {
          normalizedParameters[descriptor.name] = rawVal
        }
        break
      }
    }
  }

  // 3. Cross-field constraints validation
  if (capabilities.constraints && capabilities.constraints.length > 0) {
    for (const constraint of capabilities.constraints) {
      if (constraint.type === 'max_product' && constraint.parameters) {
        const [paramA, paramB] = constraint.parameters
        const valA = normalizedParameters[paramA]
        const valB = normalizedParameters[paramB]
        if (typeof valA === 'number' && typeof valB === 'number' && constraint.maxProduct !== undefined) {
          if (valA * valB > constraint.maxProduct) {
            errors.push({
              code: 'MAX_PRODUCT_EXCEEDED',
              message:
                constraint.message ||
                `Product of '${paramA}' and '${paramB}' (${valA * valB}) exceeds maximum allowed (${constraint.maxProduct})`,
              field: `parameters.${paramA}`,
            })
          }
        }
      } else if (constraint.type === 'requires') {
        const paramVal = normalizedParameters[constraint.parameter]
        const conditionMet =
          constraint.whenValueEquals === undefined ? paramVal !== undefined : paramVal === constraint.whenValueEquals
        if (conditionMet && constraint.targetParameter && normalizedParameters[constraint.targetParameter] === undefined) {
          errors.push({
            code: 'REQUIRED_FIELD_MISSING',
            message:
              constraint.message ||
              `Parameter '${constraint.targetParameter}' is required when '${constraint.parameter}' is specified`,
            field: `parameters.${constraint.targetParameter}`,
          })
        }
      } else if (constraint.type === 'forbidden') {
        const paramVal = normalizedParameters[constraint.parameter]
        const conditionMet =
          constraint.whenValueEquals === undefined ? paramVal !== undefined : paramVal === constraint.whenValueEquals
        if (conditionMet && constraint.targetParameter && normalizedParameters[constraint.targetParameter] !== undefined) {
          errors.push({
            code: 'FORBIDDEN_FIELD_PRESENT',
            message:
              constraint.message ||
              `Parameter '${constraint.targetParameter}' is not allowed when '${constraint.parameter}' is specified`,
            field: `parameters.${constraint.targetParameter}`,
          })
        }
      } else if (constraint.type === 'mutually_exclusive' && constraint.parameters) {
        const [paramA, paramB] = constraint.parameters
        if (normalizedParameters[paramA] !== undefined && normalizedParameters[paramB] !== undefined) {
          errors.push({
            code: 'MUTUALLY_EXCLUSIVE_PARAMETERS',
            message: constraint.message || `Parameters '${paramA}' and '${paramB}' cannot be used together`,
            field: `parameters.${paramB}`,
          })
        }
      }
    }
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

    if (!item.uploadId || typeof item.uploadId !== 'string' || item.uploadId.trim() === '') {
      errors.push({
        code: 'INVALID_INPUT_UPLOAD_ID',
        message: `Input at index ${i} must have a non-empty uploadId`,
        field: `inputs[${i}].uploadId`,
      })
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
