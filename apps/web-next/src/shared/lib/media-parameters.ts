// Browser-safe media parameter engine.
//
// Everything here is driven by the parameter descriptors the server sends, which
// the provider plugin authored. There is deliberately no model id, provider name
// or adapter string anywhere in this file: if a control appears or a value is
// rejected, the descriptor set is why. That absence is the requirement, not a
// style preference — the previous console hardcoded five size options, which is
// how the UI came to offer `1024x768` to models that accept no such thing.
//
// Validation is imported from `@musecanvas/contracts`, the same module the API
// and the plugin adapters call. A size the browser will let you submit and a
// size the server will accept are therefore the same set by construction, and a
// future provider that widens its band needs no change here.

import {
  enumOptionValues,
  evaluateCrossFieldConstraints,
  isAdvancedParameter,
  isParameterVisible,
  normalizeParameterOptions,
  reconcileParameters,
  reduceRatio,
  validateParameterValue,
  describeImageSize,
  imageConstraintViolations,
  parseImageSize,
  AUTO_SIZE_VALUE,
} from '@musecanvas/contracts'
import type {
  ImageSizeConstraints,
  ImageSizeParameterDescriptor,
  ImageSizePreset,
  IntegerParameterDescriptor,
  JsonValue,
  NumberParameterDescriptor,
  ParameterCrossFieldConstraint,
  ParameterDescriptor,
} from '@musecanvas/contracts'

/** Canonical parameter name -> accepted descriptor names (canonical first). */
export const PARAM_ALIASES: Record<string, string[]> = {
  durationSeconds: ['durationSeconds', 'duration', 'duration_s'],
  aspectRatio: ['aspectRatio', 'aspect_ratio', 'ratio'],
  resolution: ['resolution', 'resolution_type'],
  audio: ['audio', 'generateAudio', 'generate_audio'],
}

const ALIAS_TO_CANONICAL: Record<string, string> = {}
for (const [canonical, aliases] of Object.entries(PARAM_ALIASES)) {
  for (const alias of [canonical, ...aliases]) {
    if (!(alias in ALIAS_TO_CANONICAL)) ALIAS_TO_CANONICAL[alias] = canonical
  }
}

const CANONICAL_LABELS: Record<string, string> = {
  durationSeconds: '时长（秒）',
  aspectRatio: '宽高比',
  resolution: '分辨率',
  audio: '生成音频',
  count: '生成数量',
  size: '尺寸',
  quality: '质量',
}

/**
 * Descriptor types this module can render.
 *
 * An explicit allowlist rather than the previous `type !== 'text'` exclusion,
 * because the old heuristic was tuned against a server stub that declared image
 * sizes as free text: with the real descriptors in place that same filter would
 * have hidden every size control in the UI. A new type must arrive with a
 * control, so silently falling through is the failure this prevents.
 */
const RENDERABLE_TYPES = new Set(['enum', 'integer', 'number', 'boolean', 'image-size'])

export type ParameterValue = string | number | boolean
export type ParameterState = Record<string, ParameterValue>

/** Minimal view of a model this engine needs. */
export type ParameterCarrier = {
  parameters?: ParameterDescriptor[] | null
  defaults?: Record<string, unknown> | null
  maxCount?: number | null
  crossFieldConstraints?: ParameterCrossFieldConstraint[] | null
}

export function findDescriptor(
  model: ParameterCarrier | null | undefined,
  name: string,
): ParameterDescriptor | undefined {
  return model?.parameters?.find((descriptor) => descriptor.name === name)
}

/** Look a descriptor up by canonical name, tolerating legacy alias spellings. */
export function resolveDescriptor(
  model: ParameterCarrier | null | undefined,
  canonicalName: string,
): ParameterDescriptor | undefined {
  const names = new Set<string>([canonicalName, ...(PARAM_ALIASES[canonicalName] ?? [])])
  for (const name of names) {
    const descriptor = findDescriptor(model, name)
    if (descriptor) return descriptor
  }
  return undefined
}

/** Declared descriptor name -> canonical name (identity for unknown names). */
export function canonicalNameOf(descriptor: Pick<ParameterDescriptor, 'name'>): string {
  return ALIAS_TO_CANONICAL[descriptor.name] ?? descriptor.name
}

/** The single key we ever put on the wire: whatever the model declared. */
export function wireType(descriptor: Pick<ParameterDescriptor, 'name'>): string {
  return descriptor.name
}

export interface DescriptorOption {
  /** Stays in the descriptor's own value type: enum and size options are
   *  verbatim strings, integer options are numbers, boolean are booleans. */
  value: ParameterValue
  label: string
  /** Secondary text under the label, e.g. what an experimental size means. */
  description?: string
  experimental?: boolean
  isDefault: boolean
}

/** Below this many integers in range, enumerate them; above it, use a ladder. */
const INTEGER_EXHAUSTIVE_MAX = 12
/** Ladder used when an integer range is too wide to enumerate. */
const INTEGER_LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 60]

function integerOptions(descriptor: IntegerParameterDescriptor): DescriptorOption[] {
  const step = descriptor.step !== undefined && descriptor.step > 0 ? Math.trunc(descriptor.step) : 1
  const hasMin = descriptor.min !== undefined
  const hasMax = descriptor.max !== undefined
  const span = hasMin && hasMax ? (descriptor.max as number) - (descriptor.min as number) + 1 : Number.POSITIVE_INFINITY
  const values: number[] = []
  if (span <= INTEGER_EXHAUSTIVE_MAX) {
    for (let value = descriptor.min as number; value <= (descriptor.max as number); value += step) values.push(value)
  } else {
    const base = hasMin ? (descriptor.min as number) : 0
    for (const candidate of INTEGER_LADDER) {
      if (hasMin && candidate < (descriptor.min as number)) continue
      if (hasMax && candidate > (descriptor.max as number)) continue
      if ((candidate - base) % step !== 0) continue
      values.push(candidate)
    }
  }
  const defaultValue = descriptor.defaultValue
  // The descriptor's own default must always be selectable even when it sits
  // off-ladder (Seedance defaults to 5s, which no curated ladder contained).
  if (typeof defaultValue === 'number' && Number.isInteger(defaultValue)) values.push(defaultValue)
  return [...new Set(values)]
    .sort((left, right) => left - right)
    .map((value) => ({ value, label: String(value), isDefault: value === defaultValue }))
}

function numberOptions(descriptor: NumberParameterDescriptor): DescriptorOption[] {
  // A float range has no enumerable option set, so the control is a direct
  // input bounded by the descriptor; `min` and the default are the only
  // suggested values offered.
  const suggested = [...new Set(
    [descriptor.min, descriptor.defaultValue].filter((value): value is number => typeof value === 'number'),
  )]
  return suggested.map((value) => ({ value, label: String(value), isDefault: value === descriptor.defaultValue }))
}

/** The `image-size` presets as options, so a size control degrades to a plain
 *  select on a surface that has no dedicated picker. */
export function imageSizeOptions(descriptor: ImageSizeParameterDescriptor): DescriptorOption[] {
  return descriptor.presets.map((preset) => ({
    value: preset.value,
    label: describeImageSize(preset),
    description: preset.description,
    experimental: preset.experimental,
    isDefault: preset.value === (descriptor.defaultValue ?? descriptor.presets[0]?.value),
  }))
}

/** Every value a descriptor offers, in the descriptor's own value type. */
export function descriptorOptions(descriptor: ParameterDescriptor | undefined): DescriptorOption[] {
  if (!descriptor) return []
  switch (descriptor.type) {
    case 'enum': {
      const fallback = descriptor.defaultValue
      return normalizeParameterOptions(descriptor.options).map((option) => ({
        value: option.value,
        label: option.label ?? option.value,
        description: option.description,
        experimental: option.experimental,
        isDefault: option.value === fallback,
      }))
    }
    case 'integer':
      return integerOptions(descriptor)
    case 'number':
      return numberOptions(descriptor)
    case 'image-size':
      return imageSizeOptions(descriptor)
    case 'boolean': {
      const active = descriptor.defaultValue ?? true
      return [
        { value: true, label: '开', isDefault: active === true },
        { value: false, label: '关', isDefault: active === false },
      ]
    }
    default:
      return []
  }
}

/** Coerce a picked value into the JSON type the descriptor declares. */
export function marshalDescriptorValue(
  descriptor: ParameterDescriptor,
  raw: ParameterValue,
): ParameterValue {
  if (descriptor.type === 'integer' || descriptor.type === 'number') return Number(raw)
  if (descriptor.type === 'boolean') return raw === true || raw === 'true'
  return String(raw)
}

/**
 * The value to show before the user touches anything: descriptor default, then
 * the model's own `defaults` map, then the caller's fallback.
 */
export function descriptorDefault(
  model: ParameterCarrier | null | undefined,
  name: string,
  fallback: unknown,
): unknown {
  const descriptor = resolveDescriptor(model, name)
  const names = new Set<string>([
    ...(descriptor ? [descriptor.name, name, canonicalNameOf(descriptor)] : [name]),
  ])
  if (descriptor && 'defaultValue' in descriptor && descriptor.defaultValue !== undefined) {
    return marshalDescriptorValue(descriptor, descriptor.defaultValue as ParameterValue)
  }
  const defaults = model?.defaults as Record<string, unknown> | undefined
  for (const alias of names) {
    const fromDefaults = defaults?.[alias]
    if (fromDefaults !== undefined) {
      return descriptor
        ? marshalDescriptorValue(descriptor, fromDefaults as ParameterValue)
        : fromDefaults
    }
  }
  return fallback
}

/** Whether this descriptor belongs in the control bar at all. */
export function isRenderableDescriptor(descriptor: ParameterDescriptor): boolean {
  return RENDERABLE_TYPES.has(descriptor.type)
}

/**
 * The descriptors that should render right now: declared, renderable, not
 * `count` (the console shows it last with its own unit), and not suppressed by
 * an unsatisfied `dependsOn`.
 *
 * Suppression is evaluated against the live values, which is what makes
 * `output_compression` vanish the moment `output_format` goes back to `png`
 * without this file knowing either parameter's name.
 */
export function mediaControlDescriptors(
  model: ParameterCarrier | null | undefined,
  values?: ParameterState,
): ParameterDescriptor[] {
  const controls = (model?.parameters ?? []).filter((descriptor) => {
    if (!isRenderableDescriptor(descriptor)) return false
    if (descriptor.name === 'count' || canonicalNameOf(descriptor) === 'count') return false
    return isParameterVisible(descriptor, values)
  })
  const rank = (descriptor: ParameterDescriptor) => descriptor.ui?.order ?? Number.MAX_SAFE_INTEGER
  return [...controls].sort((left, right) => rank(left) - rank(right))
}

/** The descriptor's own label, else the shared Chinese name, else its key. */
export function descriptorLabel(
  descriptor: ParameterDescriptor,
  model?: ParameterCarrier | null,
): string {
  if (descriptor.label) return descriptor.label
  const canonical = canonicalNameOf(descriptor)
  const sibling = model?.parameters?.find(
    (other) => other.name !== descriptor.name && canonicalNameOf(other) === canonical && !!other.label,
  )
  if (sibling?.label) return sibling.label
  return CANONICAL_LABELS[canonical] ?? descriptor.name
}

/** `true` when this value would survive server-side validation. */
export function isLegalValue(descriptor: ParameterDescriptor, value: ParameterValue): boolean {
  return validateParameterValue(descriptor, value).length === 0
}

/**
 * Every reason the current selection would be refused, as
 * `{ parameter, message }` pairs.
 *
 * This is what separates the two ways a value can be wrong. A pick left over
 * from another model is *stale* and gets reconciled to the new model's default;
 * a size the user typed that breaks the band is *invalid*, and quietly
 * substituting a default would submit something they never asked for. Invalid
 * input must block the button instead, and this is the single call that decides
 * whether it does — the same validator the server runs, so the gate can never
 * be looser than the API's.
 */
export function parameterIssues(
  model: ParameterCarrier | null | undefined,
  values: ParameterState | undefined,
): Array<{ parameter: string; message: string }> {
  const declared = model?.parameters ?? []
  const issues: Array<{ parameter: string; message: string }> = []
  const effective: Record<string, JsonValue> = {}

  for (const descriptor of declared) {
    const canonical = canonicalNameOf(descriptor)
    const picked = values?.[canonical] ?? values?.[descriptor.name]
    if (picked === undefined) {
      const fallback = descriptorDefault(model, descriptor.name, undefined)
      if (fallback !== undefined) effective[descriptor.name] = fallback as JsonValue
      continue
    }
    if (!isParameterVisible(descriptor, values)) continue
    const marshalled = marshalDescriptorValue(descriptor, picked)
    effective[descriptor.name] = marshalled as JsonValue
    for (const issue of validateParameterValue(descriptor, marshalled as JsonValue)) {
      issues.push({ parameter: descriptor.name, message: issue.message })
    }
  }

  for (const issue of evaluateCrossFieldConstraints(model?.crossFieldConstraints ?? undefined, effective)) {
    issues.push({ parameter: issue.parameter, message: issue.message })
  }
  return issues
}

/** The value a control should show: the user's pick if still legal, else default. */
export function effectiveValue(
  model: ParameterCarrier | null | undefined,
  descriptor: ParameterDescriptor,
  values: ParameterState | undefined,
): ParameterValue | undefined {
  const picked = values?.[canonicalNameOf(descriptor)] ?? values?.[descriptor.name]
  if (picked !== undefined && isLegalValue(descriptor, picked)) {
    return marshalDescriptorValue(descriptor, picked)
  }
  const fallback = descriptorDefault(model, descriptor.name, undefined)
  return fallback === undefined ? undefined : marshalDescriptorValue(descriptor, fallback as ParameterValue)
}

/**
 * Build the `parameters` payload for the selected model.
 *
 * Iterates the model's descriptors rather than the user's state keys, and drops
 * any value that is illegal or whose `dependsOn` is unsatisfied. That makes this
 * function structurally incapable of emitting a request the server would reject:
 * switching from a model where `quality=max` was valid to one where it is not
 * produces the new model's default instead of forwarding a stale value, and it
 * holds regardless of whether the reconciliation effect below has run yet.
 */
export function buildMediaParameters(
  model: ParameterCarrier | null | undefined,
  state: ParameterState | undefined,
): ParameterState {
  const parameters: ParameterState = {}
  for (const descriptor of model?.parameters ?? []) {
    // A dependent parameter is skipped outright — value *and* default — exactly
    // as the server's validator does. Any divergence here would mean the console
    // sends a field the API strips, or vice versa.
    if (!isParameterVisible(descriptor, state)) continue
    const canonical = canonicalNameOf(descriptor)
    const picked = state?.[canonical] ?? state?.[descriptor.name]
    if (picked !== undefined && isLegalValue(descriptor, picked)) {
      parameters[wireType(descriptor)] = marshalDescriptorValue(descriptor, picked)
      continue
    }
    if (picked !== undefined) {
      // Chosen but no longer legal: fall through to the default rather than send
      // it. Silently dropping it would let the provider apply its own guess.
      const fallback = descriptorDefault(model, descriptor.name, undefined)
      if (fallback !== undefined) parameters[wireType(descriptor)] = marshalDescriptorValue(descriptor, fallback as ParameterValue)
      continue
    }
    const fallback = descriptorDefault(model, descriptor.name, undefined)
    if (fallback === undefined) continue
    parameters[wireType(descriptor)] = marshalDescriptorValue(descriptor, fallback as ParameterValue)
  }
  return parameters
}

/**
 * Reconcile carried-over selections against a newly selected model, so the
 * rendered controls agree with what `buildMediaParameters` will actually send.
 *
 * Pure and idempotent, which is what lets it run from an effect keyed on the
 * model id without risking an update loop: once the values are reconciled, the
 * next pass returns the same map.
 */
export function reconcileModelParameters(
  model: ParameterCarrier | null | undefined,
  values: ParameterState | undefined,
): ParameterState {
  return reconcileParameters((model?.parameters ?? []) as ParameterDescriptor[], values ?? {})
}

export { AUTO_SIZE_VALUE, describeImageSize, parseImageSize, reduceRatio, isAdvancedParameter }
export type { ImageSizeConstraints, ImageSizePreset }

/**
 * Validate a hand-typed custom size, returning one message per violated rule.
 *
 * Thin wrapper that exists so the size picker passes the *pair* (the constraint
 * block is shared by both edges) while the contract validator keeps the single
 * implementation the server also calls.
 */
export function customSizeViolations(
  constraints: ImageSizeConstraints | undefined,
  width: number,
  height: number,
  parameterName: string,
): string[] {
  if (!constraints) return []
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return ['请输入有效的宽度和高度']
  }
  return imageConstraintViolations(constraints, width, height, parameterName).map((issue) => issue.message)
}

/** Everything the size picker needs about a descriptor, already narrowed. */
export function asImageSizeDescriptor(
  descriptor: ParameterDescriptor | undefined,
): ImageSizeParameterDescriptor | undefined {
  return descriptor?.type === 'image-size' ? descriptor : undefined
}

/** Values a size parameter accepts, for callers that treat it generically. */
export function sizeValues(descriptor: ImageSizeParameterDescriptor): string[] {
  return descriptor.presets.map((preset) => preset.value)
}

/** Constraint hints rendered next to the custom-size inputs. */
export function describeConstraints(constraints: ImageSizeConstraints | undefined): string[] {
  if (!constraints) return []
  const hints: string[] = []
  const edge = (label: string, min?: number, max?: number) => {
    if (min !== undefined && max !== undefined) hints.push(`${label} ${min}–${max}`)
    else if (max !== undefined) hints.push(`${label} ≤ ${max}`)
    else if (min !== undefined) hints.push(`${label} ≥ ${min}`)
  }
  edge('宽度', constraints.minWidth, constraints.maxWidth)
  edge('高度', constraints.minHeight, constraints.maxHeight)
  if (constraints.widthMultipleOf) hints.push(`宽为 ${constraints.widthMultipleOf} 的倍数`)
  if (constraints.heightMultipleOf) hints.push(`高为 ${constraints.heightMultipleOf} 的倍数`)
  if (constraints.minPixels || constraints.maxPixels) {
    const format = (value: number) => value.toLocaleString('en-US')
    if (constraints.minPixels && constraints.maxPixels) {
      hints.push(`总像素 ${format(constraints.minPixels)}–${format(constraints.maxPixels)}`)
    } else if (constraints.maxPixels) {
      hints.push(`总像素 ≤ ${format(constraints.maxPixels)}`)
    } else if (constraints.minPixels) {
      hints.push(`总像素 ≥ ${format(constraints.minPixels)}`)
    }
  }
  if (constraints.maxAspectRatio) hints.push(`宽高比 ≤ ${constraints.maxAspectRatio}:1`)
  return hints
}

/** Re-exported so the console can render a business error verbatim. */
export function optionValueList(descriptor: ParameterDescriptor | undefined): string[] {
  if (!descriptor || descriptor.type !== 'enum') return []
  return enumOptionValues(descriptor.options)
}

/** JSON view of a state map, for request bodies. */
export function toParameterPayload(state: ParameterState): Record<string, JsonValue> {
  return { ...state }
}
