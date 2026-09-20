// The single parameter validator shared by the browser, the API and the plugin
// adapters.
//
// There is deliberately no second copy. Before this module existed, "is this
// size legal" had three answers: the frontend dropdown (a hardcoded list that
// offered sizes no model accepted), `route.ts` (a `type: 'text', maxLength: 32`
// stub that accepted anything up to 32 characters), and the plugin's own private
// rules table (which rejected it, after the job was already queued). The user
// saw a legal-looking choice, the API said yes, and the vendor said no.
//
// All three now call `validateParameterValue`, so a control the browser renders
// and a value the server accepts are the same set by construction.
//
// Pure and dependency-free — see the note at the top of media-parameters.ts
// about why this file may not reach for Node or DOM APIs.

import type { JsonValue, ModelCapabilities, ParameterDescriptor } from './index'
import { GenerationErrorCode } from './media-parameters'
import type {
  ImageSizeConstraints,
  ImageSizeParameterDescriptor,
  ImageSizePreset,
  ModelCapabilityFlags,
  NumberParameterDescriptor,
  ParameterCrossFieldConstraint,
  ParameterOption,
  ParameterUiHint,
} from './media-parameters'

export type MediaParameterIssue = {
  code: GenerationErrorCode
  message: string
  parameter: string
  value?: JsonValue
  constraint?: string
}

/**
 * Bounds on a declared contract. A manifest is attacker-supplied text bounded
 * only by the artifact size cap, and its descriptor set is re-read on every
 * `GET /api/models`, so the limits are enforced at declaration time rather than
 * trusted at render time.
 */
export const MEDIA_PARAMETER_LIMITS = {
  parameters: 32,
  presets: 40,
  options: 64,
  inputSlots: 12,
  crossFieldConstraints: 24,
} as const

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Accept both historical `string[]` and the richer object form, in declaration
 * order. Every reader of `options` must go through this rather than indexing the
 * raw array — that is what makes widening `EnumParameterDescriptor.options`
 * backward compatible with persisted revision snapshots.
 */
export function normalizeParameterOptions(
  options: ReadonlyArray<string | ParameterOption> | undefined,
): ParameterOption[] {
  return (options ?? []).map((option) =>
    typeof option === 'string'
      ? { value: option, label: option }
      : {
          ...option,
          label: option.label ?? option.value,
        },
  )
}

/** The bare values, for membership tests and error messages. */
export function enumOptionValues(
  options: ReadonlyArray<string | ParameterOption> | undefined,
): string[] {
  return (options ?? []).map((option) => (typeof option === 'string' ? option : option.value))
}

// ---------------------------------------------------------------------------
// Image size geometry
// ---------------------------------------------------------------------------

const SIZE_PATTERN = /^([0-9]{1,5})x([0-9]{1,5})$/

/** `auto` is a legal wire value that carries no geometry, so it is checked separately. */
export const AUTO_SIZE_VALUE = 'auto'

export function parseImageSize(value: string): { width: number; height: number } | null {
  const match = SIZE_PATTERN.exec(value)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/** Parse and resolve a size to pixels, tolerating `auto` via the preset list. */
export function imageSizeToPixels(
  descriptor: Pick<ImageSizeParameterDescriptor, 'presets'>,
  value: string,
): { width: number; height: number } | null {
  const parsed = parseImageSize(value)
  if (parsed) return parsed
  const preset = descriptor.presets.find((candidate) => candidate.value === value)
  if (preset?.width && preset?.height) return { width: preset.width, height: preset.height }
  return null
}

/** Aspect ratio as long edge over short edge, so portrait and landscape match. */
export function sizeAspectRatio(width: number, height: number): number {
  if (width <= 0 || height <= 0) return Number.POSITIVE_INFINITY
  return Math.max(width, height) / Math.min(width, height)
}

/** Deterministic thousands separators, without leaning on a locale. */
function formatCount(value: number): string {
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function ratioLabel(max: number): string {
  return `${max}:1`
}

/**
 * Check one candidate `WIDTHxHEIGHT` against a constraint block.
 *
 * Exported on its own because the size picker needs the *specific* violated rule
 * to render an inline message while the user types, not just an overall verdict.
 */
export function imageConstraintViolations(
  constraints: ImageSizeConstraints,
  width: number,
  height: number,
  parameterName: string,
): MediaParameterIssue[] {
  const issues: MediaParameterIssue[] = []
  const push = (message: string, constraint: string) =>
    issues.push({
      code: GenerationErrorCode.MEDIA_PARAMETER_CONSTRAINT_FAILED,
      message,
      parameter: parameterName,
      value: `${width}x${height}`,
      constraint,
    })

  if (constraints.minWidth !== undefined && width < constraints.minWidth) {
    push(`宽度不能小于 ${constraints.minWidth} 像素`, 'minWidth')
  }
  if (constraints.maxWidth !== undefined && width > constraints.maxWidth) {
    push(`宽度不能超过 ${constraints.maxWidth} 像素`, 'maxWidth')
  }
  if (constraints.minHeight !== undefined && height < constraints.minHeight) {
    push(`高度不能小于 ${constraints.minHeight} 像素`, 'minHeight')
  }
  if (constraints.maxHeight !== undefined && height > constraints.maxHeight) {
    push(`高度不能超过 ${constraints.maxHeight} 像素`, 'maxHeight')
  }
  if (constraints.widthMultipleOf !== undefined && constraints.widthMultipleOf > 0
    && width % constraints.widthMultipleOf !== 0) {
    push(`宽度必须是 ${constraints.widthMultipleOf} 的整数倍`, 'widthMultipleOf')
  }
  if (constraints.heightMultipleOf !== undefined && constraints.heightMultipleOf > 0
    && height % constraints.heightMultipleOf !== 0) {
    push(`高度必须是 ${constraints.heightMultipleOf} 的整数倍`, 'heightMultipleOf')
  }

  const pixels = width * height
  if (!Number.isSafeInteger(pixels)) {
    push('宽高乘积超出可处理范围', 'maxPixels')
    return issues
  }
  if (constraints.minPixels !== undefined && pixels < constraints.minPixels) {
    push(`总像素数不能少于 ${formatCount(constraints.minPixels)}（当前 ${formatCount(pixels)}）`, 'minPixels')
  }
  if (constraints.maxPixels !== undefined && pixels > constraints.maxPixels) {
    push(`总像素数不能超过 ${formatCount(constraints.maxPixels)}（当前 ${formatCount(pixels)}）`, 'maxPixels')
  }

  if (constraints.maxAspectRatio !== undefined) {
    const ratio = sizeAspectRatio(width, height)
    if (ratio > constraints.maxAspectRatio + Number.EPSILON) {
      push(`宽高比不能超过 ${ratioLabel(constraints.maxAspectRatio)}（当前 ${ratio.toFixed(2)}:1）`, 'maxAspectRatio')
    }
  }

  return issues
}

/**
 * Validate one `image-size` value.
 *
 * Two rules worth stating because they are the opposite of the obvious default:
 *
 * 1. Presets are checked against `constraints` too. A preset is a promise that
 *    the value is legal, so a preset outside its own model's band is a bug in
 *    the *declaration*, and `validateModelCapabilities` rejects it at scan time
 *    rather than letting the runtime paper over it.
 * 2. `allowCustom` is what makes anything outside the preset list legal — it is
 *    never inferred from the presence of `constraints`.
 */
export function validateImageSizeValue(
  descriptor: ImageSizeParameterDescriptor,
  raw: JsonValue,
): MediaParameterIssue[] {
  const name = descriptor.name
  if (typeof raw !== 'string') {
    return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是字符串`, parameter: name, value: raw }]
  }
  const value = raw.trim()
  const preset = descriptor.presets.find((candidate) => candidate.value === value)
  const constraints = descriptor.constraints ?? {}

  if (preset) {
    if (value === AUTO_SIZE_VALUE) return []
    const parsed = parseImageSize(value)
    if (!parsed) {
      return [{ code: GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER, message: `参数 '${name}' 的尺寸格式无效：${value}`, parameter: name, value }]
    }
    // Geometry declared by the plugin is authoritative even for presets, so a
    // preset the vendor has since narrowed cannot survive a plugin edit.
    return imageConstraintViolations(constraints, parsed.width, parsed.height, name)
  }

  if (!descriptor.allowCustom) {
    return [{
      code: GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER,
      message: `参数 '${name}' 不支持尺寸 ${value}；该模型可选：${descriptor.presets.map((p) => p.value).join(', ')}`,
      parameter: name,
      value,
      constraint: 'presets',
    }]
  }

  const parsed = parseImageSize(value)
  if (!parsed) {
    return [{ code: GenerationErrorCode.MEDIA_PARAMETER_CONSTRAINT_FAILED, message: `参数 '${name}' 必须形如 宽x高（例如 1536x864）`, parameter: name, value, constraint: 'format' }]
  }
  return imageConstraintViolations(constraints, parsed.width, parsed.height, name)
}

function validateNumberValue(descriptor: NumberParameterDescriptor, raw: JsonValue): MediaParameterIssue[] {
  const name = descriptor.name
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是数字`, parameter: name, value: raw }]
  }
  if (descriptor.min !== undefined && raw < descriptor.min) {
    return [{ code: GenerationErrorCode.PARAMETER_OUT_OF_RANGE, message: `参数 '${name}' 必须 >= ${descriptor.min}`, parameter: name, value: raw }]
  }
  if (descriptor.max !== undefined && raw > descriptor.max) {
    return [{ code: GenerationErrorCode.PARAMETER_OUT_OF_RANGE, message: `参数 '${name}' 必须 <= ${descriptor.max}`, parameter: name, value: raw }]
  }
  if (descriptor.precision !== undefined) {
    const factor = 10 ** descriptor.precision
    // Compare against the rounded scaled value; `Number.isInteger(Math.round(x))`
    // is vacuously true, which is exactly the kind of check that looks right and
    // silently accepts everything.
    const scaled = raw * factor
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      return [{ code: GenerationErrorCode.PARAMETER_STEP_MISMATCH, message: `参数 '${name}' 最多保留 ${descriptor.precision} 位小数`, parameter: name, value: raw }]
    }
  }
  if (descriptor.step !== undefined && descriptor.step > 0) {
    const base = descriptor.min ?? 0
    const steps = (raw - base) / descriptor.step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return [{ code: GenerationErrorCode.PARAMETER_STEP_MISMATCH, message: `参数 '${name}' 必须是 ${descriptor.step} 的整数倍`, parameter: name, value: raw }]
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Per-parameter dispatch
// ---------------------------------------------------------------------------

/**
 * Validate one value against one descriptor.
 *
 * The `default` arm is load-bearing. A missing `case` used to fall out of the
 * switch without recording anything, which silently *dropped* the parameter from
 * the normalized request — during a blue/green deploy where an older worker
 * reads a newer revision, that would send a generation with no size at all and
 * no error anywhere. An unrecognised `type` is now a hard failure.
 */
export function validateParameterValue(descriptor: ParameterDescriptor, raw: JsonValue): MediaParameterIssue[] {
  switch (descriptor.type) {
    case 'enum': {
      const name = descriptor.name
      if (typeof raw !== 'string') {
        return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是字符串`, parameter: name, value: raw }]
      }
      const allowed = enumOptionValues(descriptor.options)
      if (!allowed.includes(raw)) {
        return [{
          code: GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER,
          message: `参数 '${name}' 的值 '${raw}' 不被该模型支持；可选：${allowed.join(', ')}`,
          parameter: name,
          value: raw,
          constraint: 'options',
        }]
      }
      return []
    }

    case 'integer': {
      const name = descriptor.name
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
        return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是整数`, parameter: name, value: raw }]
      }
      if (descriptor.min !== undefined && raw < descriptor.min) {
        return [{ code: GenerationErrorCode.PARAMETER_OUT_OF_RANGE, message: `参数 '${name}' 必须 >= ${descriptor.min}`, parameter: name, value: raw }]
      }
      if (descriptor.max !== undefined && raw > descriptor.max) {
        return [{ code: GenerationErrorCode.PARAMETER_OUT_OF_RANGE, message: `参数 '${name}' 必须 <= ${descriptor.max}`, parameter: name, value: raw }]
      }
      if (descriptor.step !== undefined && descriptor.step > 0) {
        const base = descriptor.min ?? 0
        if ((raw - base) % descriptor.step !== 0) {
          return [{ code: GenerationErrorCode.PARAMETER_STEP_MISMATCH, message: `参数 '${name}' 必须与步长 ${descriptor.step} 对齐`, parameter: name, value: raw }]
        }
      }
      return []
    }

    case 'number':
      return validateNumberValue(descriptor, raw)

    case 'boolean': {
      const name = descriptor.name
      return typeof raw === 'boolean'
        ? []
        : [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是布尔值`, parameter: name, value: raw }]
    }

    case 'text': {
      const name = descriptor.name
      if (typeof raw !== 'string') {
        return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 必须是字符串`, parameter: name, value: raw }]
      }
      if (descriptor.minLength !== undefined && raw.length < descriptor.minLength) {
        return [{ code: GenerationErrorCode.TEXT_TOO_SHORT, message: `参数 '${name}' 长度必须 >= ${descriptor.minLength}`, parameter: name, value: raw }]
      }
      if (descriptor.maxLength !== undefined && raw.length > descriptor.maxLength) {
        return [{ code: GenerationErrorCode.TEXT_TOO_LONG, message: `参数 '${name}' 长度必须 <= ${descriptor.maxLength}`, parameter: name, value: raw }]
      }
      if (descriptor.pattern !== undefined) {
        let pattern: RegExp | null = null
        try {
          pattern = new RegExp(descriptor.pattern)
        } catch {
          // A bad pattern is a declaration bug, not a user error: refuse rather
          // than let a broken regex silently accept everything.
          return [{ code: GenerationErrorCode.INVALID_PARAMETER_TYPE, message: `参数 '${name}' 的校验表达式无效，请联系管理员`, parameter: name }]
        }
        if (!pattern.test(raw)) {
          return [{ code: GenerationErrorCode.TEXT_PATTERN_MISMATCH, message: `参数 '${name}' 不符合格式要求`, parameter: name, value: raw }]
        }
      }
      return []
    }

    case 'image-size':
      return validateImageSizeValue(descriptor, raw)

    default: {
      // Exhaustiveness guard: adding a descriptor variant without a case here is
      // a compile error, and a value that reaches runtime unhandled is an error.
      const unknown = descriptor as ParameterDescriptor
      return [{
        code: GenerationErrorCode.INVALID_PARAMETER_TYPE,
        message: `参数 '${unknown?.name ?? 'unknown'}' 的类型 '${(unknown as { type?: string })?.type}' 不受支持`,
        parameter: unknown?.name ?? 'unknown',
      }]
    }
  }
}

// ---------------------------------------------------------------------------
// Visibility (dependsOn)
// ---------------------------------------------------------------------------

/**
 * Whether a control should be rendered / a value be sent at all.
 *
 * Comparison is string-space with an exact-match fast path, matching how the
 * existing controls already compare values: some providers declare an enum as
 * `'8'` while normalization turns it into `8`, and a dependency written either
 * way must behave the same.
 */
export function isParameterVisible(
  descriptor: Pick<ParameterDescriptor, 'name' | 'dependsOn'>,
  values: Record<string, JsonValue | string | number | boolean> | undefined,
): boolean {
  const dependency = descriptor.dependsOn
  if (!dependency) return true
  if (!values) return false
  const current = values[dependency.parameter]
  if (current === undefined) return false
  return dependency.values.some((expected) => expected === current || String(expected) === String(current))
}

/** The descriptors the user may currently see, preserving declaration order. */
export function resolveParameterVisibility<T extends Pick<ParameterDescriptor, 'name' | 'dependsOn'>>(
  descriptors: readonly T[],
  values: Record<string, JsonValue | string | number | boolean> | undefined,
): T[] {
  return descriptors.filter((descriptor) => isParameterVisible(descriptor, values))
}

// ---------------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------------

/**
 * Evaluate relational rules over an already-type-checked parameter set.
 *
 * Returns `MEDIA_PARAMETER_CONSTRAINT_FAILED` rather than the legacy
 * `FORBIDDEN_FIELD_PRESENT` family when a `message` is supplied by the plugin,
 * because the user-facing requirement is a specific, explainable business error
 * ("background=transparent 时 output_format 只能是 png 或 webp"), not a generic
 * schema violation.
 */
export function evaluateCrossFieldConstraints(
  constraints: readonly ParameterCrossFieldConstraint[] | undefined,
  parameters: Record<string, JsonValue>,
): MediaParameterIssue[] {
  const issues: MediaParameterIssue[] = []
  for (const constraint of constraints ?? []) {
    const sourceValue = parameters[constraint.parameter]

    if (constraint.type === 'max_product' && constraint.parameters) {
      const [paramA, paramB] = constraint.parameters
      const valueA = parameters[paramA]
      const valueB = parameters[paramB]
      if (typeof valueA === 'number' && typeof valueB === 'number' && constraint.maxProduct !== undefined
        && valueA * valueB > constraint.maxProduct) {
        issues.push({
          code: GenerationErrorCode.MAX_PRODUCT_EXCEEDED,
          message: constraint.message ?? `参数 '${paramA}' 与 '${paramB}' 的乘积超出上限 ${constraint.maxProduct}`,
          parameter: paramA,
          constraint: 'max_product',
        })
      }
      continue
    }

    if (constraint.type === 'mutually_exclusive' && constraint.parameters) {
      const [paramA, paramB] = constraint.parameters
      if (parameters[paramA] !== undefined && parameters[paramB] !== undefined) {
        issues.push({
          code: GenerationErrorCode.MUTUALLY_EXCLUSIVE_PARAMETERS,
          message: constraint.message ?? `参数 '${paramA}' 与 '${paramB}' 不能同时设置`,
          parameter: paramB,
          constraint: 'mutually_exclusive',
        })
      }
      continue
    }

    const conditionMet = constraint.whenValueEquals === undefined
      ? sourceValue !== undefined
      : sourceValue === constraint.whenValueEquals || String(sourceValue) === String(constraint.whenValueEquals)

    if (!conditionMet || !constraint.targetParameter) continue

    const targetValue = parameters[constraint.targetParameter]

    if (constraint.type === 'requires' && targetValue === undefined) {
      issues.push({
        code: GenerationErrorCode.REQUIRED_FIELD_MISSING,
        message: constraint.message ?? `设置 '${constraint.parameter}' 时必须提供 '${constraint.targetParameter}'`,
        parameter: constraint.targetParameter,
        constraint: 'requires',
      })
      continue
    }

    if (constraint.type === 'forbidden') {
      if (targetValue === undefined) continue
      // `targetValues` narrows the pair to the specific offending values, which
      // is how "transparent + jpeg is illegal, transparent + png is fine" reads
      // as one declarative rule instead of a branch in imperative code.
      if (constraint.targetValues && !constraint.targetValues.some((v) => v === targetValue || String(v) === String(targetValue))) {
        continue
      }
      issues.push({
        code: GenerationErrorCode.MEDIA_PARAMETER_CONSTRAINT_FAILED,
        message: constraint.message ?? `参数 '${constraint.targetParameter}' 不能与 '${constraint.parameter}' 同时设置`,
        parameter: constraint.targetParameter,
        value: targetValue,
        constraint: 'forbidden',
      })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Model-switch reconciliation
// ---------------------------------------------------------------------------

export type ParameterValueMap = Record<string, string | number | boolean>

/** `true` when the descriptor accepts this value outright. */
export function isLegalValue(
  descriptor: ParameterDescriptor,
  value: string | number | boolean,
): boolean {
  return validateParameterValue(descriptor, value).length === 0
}

/**
 * Reconcile a carried-over parameter selection against a newly selected model.
 *
 * Values that stay legal survive; anything the new model does not offer is
 * dropped so the request builder falls back to that descriptor's own default.
 * This is what makes switching from a `quality=max` model to one without `max`
 * produce `quality=auto` rather than sending a value the vendor will reject —
 * and it drops values whose controlling parameter is no longer set too, so a
 * hidden `output_compression` can never ride along invisibly.
 *
 * Pure and idempotent: running it twice yields the same map, which is what lets
 * it sit in an effect keyed on the model id without risking an update loop.
 */
export function reconcileParameters(
  descriptors: readonly ParameterDescriptor[],
  values: ParameterValueMap | undefined,
): ParameterValueMap {
  if (!values) return {}
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]))
  const reconciled: ParameterValueMap = {}

  for (const [name, value] of Object.entries(values)) {
    const descriptor = byName.get(name)
    // Undeclared here means the previous model had a knob this one does not.
    if (!descriptor) continue
    if (!isParameterVisible(descriptor, values)) continue
    if (validateParameterValue(descriptor, value).length > 0) continue
    reconciled[name] = value
  }
  return reconciled
}

// ---------------------------------------------------------------------------
// Declaration well-formedness
// ---------------------------------------------------------------------------

export interface ModelCapabilitiesValidationResult {
  ok: boolean
  capabilities: ModelCapabilities | null
  findings: Array<{ rule: string; message: string }>
}

const DESCRIPTOR_TYPES = new Set(['enum', 'integer', 'number', 'boolean', 'text', 'image-size'])
const GENERATION_MODES = new Set(['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural check for a model's declared contract, used at plugin-scan time,
 * at admin write time, and when re-reading a persisted snapshot.
 *
 * The strictness is a deliberate stance against the "unknown model" failure
 * mode: a plugin cannot smuggle in a descriptor type the host does not know how
 * to validate, cannot advertise `imageEdit` without the matching mode, and
 * cannot offer a preset outside the band it declared for itself. Where the
 * declaration is wrong we reject the declaration, rather than guess a
 * capability at request time.
 */
export function validateModelCapabilities(input: unknown): ModelCapabilitiesValidationResult {
  const findings: Array<{ rule: string; message: string }> = []
  const reject = (rule: string, message: string) => findings.push({ rule, message })

  if (!isRecord(input)) {
    return { ok: false, capabilities: null, findings: [{ rule: 'INVALID_MODEL_CAPABILITIES', message: 'capabilities must be an object' }] }
  }

  const modes = Array.isArray(input.modes) ? input.modes.filter((m): m is string => typeof m === 'string') : []
  if (!Array.isArray(input.modes)) reject('INVALID_MODEL_CAPABILITIES', 'modes must be an array')
  for (const mode of modes) {
    if (!GENERATION_MODES.has(mode)) reject('INVALID_MODEL_CAPABILITIES', `unknown generation mode '${mode}'`)
  }

  const parameters = validateParameters(input.parameters, reject)
  const inputSlots = validateInputSlots(input.inputSlots, reject)
  const flags = validateFlags(input.flags, reject)
  const constraints = validateCrossFieldDeclaration(input.crossFieldConstraints, parameters, reject)
  validateFlagModeAgreement(flags, modes, reject)
  validateDefaults(input.defaults, parameters, reject)

  if (Array.isArray(input.parameters) && input.parameters.length > MEDIA_PARAMETER_LIMITS.parameters) {
    reject('PARAMETER_LIMIT', `parameters exceeds the limit of ${MEDIA_PARAMETER_LIMITS.parameters}`)
  }

  if (findings.length > 0) return { ok: false, capabilities: null, findings }

  const capabilities = {
    modes: modes as ModelCapabilities['modes'],
    parameters,
    inputSlots,
    ...(typeof input.maxCount === 'number' ? { maxCount: input.maxCount } : {}),
    ...(Array.isArray(input.supportedMediaKinds)
      ? { supportedMediaKinds: input.supportedMediaKinds as ModelCapabilities['supportedMediaKinds'] }
      : {}),
    ...(flags ? { flags } : {}),
    ...(constraints && constraints.length > 0 ? { crossFieldConstraints: constraints } : {}),
    ...(typeof input.declaredBy === 'string' ? { declaredBy: input.declaredBy } : {}),
    ...(typeof input.deprecated === 'boolean' ? { deprecated: input.deprecated } : {}),
    ...(typeof input.deprecationNote === 'string' ? { deprecationNote: input.deprecationNote } : {}),
  } as ModelCapabilities

  return { ok: true, capabilities, findings }
}

function validateParameters(
  raw: unknown,
  reject: (rule: string, message: string) => void,
): ParameterDescriptor[] {
  if (!Array.isArray(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'parameters must be an array')
    return []
  }
  const seen = new Set<string>()
  const descriptors: ParameterDescriptor[] = []

  for (const entry of raw) {
    if (!isRecord(entry)) {
      reject('INVALID_MODEL_CAPABILITIES', 'every parameter must be an object')
      continue
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) {
      reject('INVALID_MODEL_CAPABILITIES', 'every parameter needs a non-empty name')
      continue
    }
    if (seen.has(name)) {
      reject('INVALID_MODEL_CAPABILITIES', `parameter '${name}' is declared twice`)
      continue
    }
    seen.add(name)

    const type = entry.type
    if (typeof type !== 'string' || !DESCRIPTOR_TYPES.has(type)) {
      // Rule: never guess an unknown parameter type. Reject the declaration.
      reject('UNKNOWN_PARAMETER_TYPE', `parameter '${name}' declares unknown type '${String(type)}'`)
      continue
    }

    if (entry.dependsOn !== undefined) {
      const dependency = entry.dependsOn
      if (!isRecord(dependency) || typeof dependency.parameter !== 'string' || !Array.isArray(dependency.values)) {
        reject('INVALID_MODEL_CAPABILITIES', `parameter '${name}' has a malformed dependsOn`)
      } else if (seen.has(dependency.parameter) === false) {
        reject('CROSS_FIELD_UNKNOWN_PARAMETER', `parameter '${name}' depends on undeclared '${dependency.parameter}'`)
      }
    }

    if (type === 'image-size') {
      validateImageSizeDeclaration(name, entry, reject)
    }
    if (type === 'enum') {
      const options = entry.options
      if (!Array.isArray(options) || options.length === 0) {
        reject('INVALID_MODEL_CAPABILITIES', `enum parameter '${name}' must declare a non-empty options array`)
      } else {
        if (options.length > MEDIA_PARAMETER_LIMITS.options) {
          reject('PARAMETER_LIMIT', `enum parameter '${name}' exceeds the option limit of ${MEDIA_PARAMETER_LIMITS.options}`)
        }
        const values = enumOptionValues(options as Array<string | ParameterOption>)
        if (new Set(values).size !== values.length) {
          reject('INVALID_MODEL_CAPABILITIES', `enum parameter '${name}' declares duplicate options`)
        }
        if (typeof entry.defaultValue === 'string' && !values.includes(entry.defaultValue)) {
          reject('DEFAULT_NOT_ALLOWED', `enum parameter '${name}' defaults to unoffered value '${entry.defaultValue}'`)
        }
      }
    }
    if (type === 'integer' || type === 'number') {
      const min = entry.min
      const max = entry.max
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        reject('INVALID_MODEL_CAPABILITIES', `parameter '${name}' declares min > max`)
      }
      const defaultValue = entry.defaultValue
      if (typeof defaultValue === 'number') {
        const issues = validateParameterValue(entry as unknown as ParameterDescriptor, defaultValue)
        if (issues.length > 0) {
          reject('DEFAULT_NOT_ALLOWED', `parameter '${name}' defaults to an illegal value: ${issues[0].message}`)
        }
      }
    }

    descriptors.push(entry as unknown as ParameterDescriptor)
  }

  return descriptors
}

function validateImageSizeDeclaration(
  name: string,
  entry: Record<string, unknown>,
  reject: (rule: string, message: string) => void,
): void {
  const presets = entry.presets
  if (!Array.isArray(presets) || presets.length === 0) {
    reject('INVALID_IMAGE_SIZE_RULES', `image-size parameter '${name}' must declare a non-empty presets array`)
    return
  }
  if (presets.length > MEDIA_PARAMETER_LIMITS.presets) {
    reject('PARAMETER_LIMIT', `image-size parameter '${name}' exceeds the preset limit of ${MEDIA_PARAMETER_LIMITS.presets}`)
  }
  const constraints = isRecord(entry.constraints) ? (entry.constraints as ImageSizeConstraints) : undefined
  if (entry.allowCustom === true && !constraints) {
    reject('INVALID_IMAGE_SIZE_RULES', `image-size parameter '${name}' allows custom sizes but declares no constraints`)
  }
  if (constraints) {
    if (typeof constraints.minWidth === 'number' && typeof constraints.maxWidth === 'number'
      && constraints.minWidth > constraints.maxWidth) {
      reject('INVALID_IMAGE_SIZE_RULES', `'${name}' declares minWidth > maxWidth`)
    }
    if (typeof constraints.minHeight === 'number' && typeof constraints.maxHeight === 'number'
      && constraints.minHeight > constraints.maxHeight) {
      reject('INVALID_IMAGE_SIZE_RULES', `'${name}' declares minHeight > maxHeight`)
    }
    if (typeof constraints.minPixels === 'number' && typeof constraints.maxPixels === 'number'
      && constraints.minPixels > constraints.maxPixels) {
      reject('INVALID_IMAGE_SIZE_RULES', `'${name}' declares minPixels > maxPixels`)
    }
  }

  const values: string[] = []
  for (const preset of presets) {
    if (!isRecord(preset) || typeof preset.label !== 'string' || typeof preset.value !== 'string') {
      reject('INVALID_IMAGE_SIZE_RULES', `image-size parameter '${name}' has a preset without label/value`)
      continue
    }
    values.push(preset.value)
    if (preset.value === AUTO_SIZE_VALUE) continue
    const parsed = parseImageSize(preset.value)
    if (!parsed) {
      reject('INVALID_IMAGE_SIZE_RULES', `image-size preset '${preset.value}' of '${name}' is neither 'auto' nor WIDTHxHEIGHT`)
      continue
    }
    // A preset is a promise of legality, so it must satisfy its own band.
    if (constraints) {
      const issues = imageConstraintViolations(constraints, parsed.width, parsed.height, name)
      if (issues.length > 0) {
        reject('INVALID_IMAGE_SIZE_RULES', `image-size preset '${preset.value}' of '${name}' violates its own constraints: ${issues[0].message}`)
      }
    }
    const presetWidth = preset.width
    const presetHeight = preset.height
    if ((presetWidth !== undefined || presetHeight !== undefined)
      && (presetWidth !== parsed.width || presetHeight !== parsed.height)) {
      reject('INVALID_IMAGE_SIZE_RULES', `image-size preset '${preset.value}' of '${name}' declares geometry that disagrees with its value`)
    }
  }
  if (new Set(values).size !== values.length) {
    reject('INVALID_IMAGE_SIZE_RULES', `image-size parameter '${name}' declares duplicate presets`)
  }
  if (typeof entry.defaultValue === 'string' && !values.includes(entry.defaultValue)) {
    reject('DEFAULT_NOT_ALLOWED', `image-size parameter '${name}' defaults to unoffered value '${entry.defaultValue}'`)
  }
}

function validateInputSlots(
  raw: unknown,
  reject: (rule: string, message: string) => void,
): ModelCapabilities['inputSlots'] {
  if (!Array.isArray(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'inputSlots must be an array')
    return []
  }
  if (raw.length > MEDIA_PARAMETER_LIMITS.inputSlots) {
    reject('PARAMETER_LIMIT', `inputSlots exceeds the limit of ${MEDIA_PARAMETER_LIMITS.inputSlots}`)
  }
  const slots: ModelCapabilities['inputSlots'] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.role !== 'string' || !entry.role.trim()) {
      reject('INVALID_MODEL_CAPABILITIES', 'every input slot needs a non-empty role')
      continue
    }
    const minCount = typeof entry.minCount === 'number' ? entry.minCount : 0
    const maxCount = typeof entry.maxCount === 'number' ? entry.maxCount : 0
    if (maxCount < minCount) {
      reject('INVALID_MODEL_CAPABILITIES', `input slot '${entry.role}' declares maxCount below minCount`)
      continue
    }
    if (entry.required === true && maxCount === 0) {
      reject('INVALID_MODEL_CAPABILITIES', `input slot '${entry.role}' is required but accepts no media`)
      continue
    }
    slots.push(entry as unknown as ModelCapabilities['inputSlots'][number])
  }
  return slots
}

function validateFlags(
  raw: unknown,
  reject: (rule: string, message: string) => void,
): ModelCapabilityFlags | null {
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'flags must be an object when present')
    return null
  }
  const known: Array<keyof ModelCapabilityFlags> = [
    'textToImage', 'imageToImage', 'imageEdit', 'inpainting', 'mask', 'transparentBackground',
  ]
  const flags: ModelCapabilityFlags = {}
  for (const key of known) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      reject('INVALID_MODEL_CAPABILITIES', `flags.${key} must be a boolean when present`)
      continue
    }
    flags[key] = value
  }
  return flags
}

/**
 * `flags` and `modes` are two spellings of one fact, so they must agree.
 * Without this check a plugin could advertise `imageEdit: true` on a model whose
 * modes are text-to-image only, and the mask editor would offer a surface that
 * the request builder then rejects.
 */
function validateFlagModeAgreement(
  flags: ModelCapabilityFlags | null,
  modes: string[],
  reject: (rule: string, message: string) => void,
): void {
  if (!flags) return
  const hasImageMode = modes.some((mode) => mode === 'text_to_image' || mode === 'image_to_image')
  if (!hasImageMode) return

  if (flags.textToImage === true && !modes.includes('text_to_image')) {
    reject('CAPABILITY_MODE_MISMATCH', "flags.textToImage requires mode 'text_to_image'")
  }
  if (flags.textToImage === false && modes.includes('text_to_image')) {
    reject('CAPABILITY_MODE_MISMATCH', "modes include 'text_to_image' but flags.textToImage is false")
  }
  const imageToImageMode = modes.includes('image_to_image')
  if (flags.imageToImage === true && !imageToImageMode) {
    reject('CAPABILITY_MODE_MISMATCH', "flags.imageToImage requires mode 'image_to_image'")
  }
  if (flags.imageToImage === false && imageToImageMode) {
    reject('CAPABILITY_MODE_MISMATCH', "modes include 'image_to_image' but flags.imageToImage is false")
  }
  if ((flags.inpainting === true || flags.imageEdit === true) && !imageToImageMode) {
    reject('CAPABILITY_MODE_MISMATCH', 'edit/inpainting capability requires mode image_to_image')
  }
}

function validateCrossFieldDeclaration(
  raw: unknown,
  parameters: ParameterDescriptor[],
  reject: (rule: string, message: string) => void,
): ParameterCrossFieldConstraint[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'crossFieldConstraints must be an array when present')
    return null
  }
  if (raw.length > MEDIA_PARAMETER_LIMITS.crossFieldConstraints) {
    reject('PARAMETER_LIMIT', `crossFieldConstraints exceeds the limit of ${MEDIA_PARAMETER_LIMITS.crossFieldConstraints}`)
    return null
  }
  const declared = new Set(parameters.map((descriptor) => descriptor.name))
  const constraints: ParameterCrossFieldConstraint[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== 'string') {
      reject('INVALID_MODEL_CAPABILITIES', 'every cross-field constraint must be an object with a type')
      continue
    }
    if (!['requires', 'forbidden', 'mutually_exclusive', 'max_product'].includes(entry.type)) {
      reject('INVALID_MODEL_CAPABILITIES', `unknown cross-field constraint type '${entry.type}'`)
      continue
    }
    const named: string[] = []
    if (typeof entry.parameter === 'string') named.push(entry.parameter)
    if (typeof entry.targetParameter === 'string') named.push(entry.targetParameter)
    if (Array.isArray(entry.parameters)) named.push(...entry.parameters.filter((p): p is string => typeof p === 'string'))
    const unknown = named.filter((name) => !declared.has(name))
    if (unknown.length > 0) {
      // A rule about a parameter the model never declared is a rule that can
      // never fire, so keeping it would only hide the mistake.
      reject('CROSS_FIELD_UNKNOWN_PARAMETER', `cross-field constraint references undeclared parameter(s): ${unknown.join(', ')}`)
      continue
    }
    if ((entry.type === 'requires' || entry.type === 'forbidden') && typeof entry.targetParameter !== 'string') {
      reject('INVALID_MODEL_CAPABILITIES', `'${entry.type}' requires a targetParameter`)
      continue
    }
    if ((entry.type === 'mutually_exclusive' || entry.type === 'max_product') && !Array.isArray(entry.parameters)) {
      reject('INVALID_MODEL_CAPABILITIES', `'${entry.type}' requires a parameters pair`)
      continue
    }
    constraints.push(entry as unknown as ParameterCrossFieldConstraint)
  }
  return constraints
}

function validateDefaults(
  raw: unknown,
  parameters: ParameterDescriptor[],
  reject: (rule: string, message: string) => void,
): void {
  if (raw === undefined || raw === null) return
  if (!isRecord(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'defaults must be an object when present')
    return
  }
  for (const [name, value] of Object.entries(raw)) {
    const descriptor = parameters.find((candidate) => candidate.name === name)
    if (!descriptor) {
      reject('DEFAULT_NOT_ALLOWED', `default refers to undeclared parameter '${name}'`)
      continue
    }
    if (!isRecord(value) && !Array.isArray(value)) {
      const issues = validateParameterValue(descriptor, value as JsonValue)
      if (issues.length > 0) {
        reject('DEFAULT_NOT_ALLOWED', `default for '${name}' is illegal: ${issues[0].message}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by browser and admin UI
// ---------------------------------------------------------------------------

/** `1:1 · 1024 × 1024` from geometry alone, so the UI never rederives ratios. */
export function describeImageSize(preset: ImageSizePreset): string {
  if (preset.value === AUTO_SIZE_VALUE) return preset.label
  if (!preset.width || !preset.height) return preset.label
  const ratio = reduceRatio(preset.width, preset.height)
  return `${ratio} · ${preset.width} × ${preset.height}`
}

/** `1536x1024` -> `3:2`, via Euclid so non-round-number sizes still read well. */
export function reduceRatio(width: number, height: number): string {
  const divisor = gcd(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a))
  let y = Math.abs(Math.trunc(b))
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x
}

/** Whether a descriptor belongs in the main control bar or the advanced group. */
export function isAdvancedParameter(descriptor: Pick<ParameterDescriptor, 'ui'>): boolean {
  return (descriptor.ui as ParameterUiHint | undefined)?.advanced === true
}
