// 媒体参数控件引擎：所有控件都由服务端下发的 descriptor 驱动，
// 合法性校验直接调用 `@musecanvas/contracts`（与 API/插件同一份实现），
// 因此「浏览器能提交的值」与「服务端接受的值」按构造一致。
//
// 本模块包含运行时依赖（contracts 校验器），只供 UI/客户端 hook 使用；
// 纯参数解析与请求体构造在 `generation-params.ts`，可在 node --test 下运行。

import {
  AUTO_SIZE_VALUE,
  describeImageSize,
  enumOptionValues,
  evaluateCrossFieldConstraints,
  imageConstraintViolations,
  isAdvancedParameter,
  isParameterVisible,
  normalizeParameterOptions,
  parseImageSize,
  reconcileParameters,
  reduceRatio,
  validateParameterValue,
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
  ParameterOption,
} from '@musecanvas/contracts'
import type { ParameterState, ParameterValue } from '@/shared/types'

/** 规范参数名 → descriptor 可能声明过的别名（规范名在首位）。 */
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

/** 有对应控件的 descriptor 类型；新增类型必须同时落地控件，避免静默漏渲染。 */
const RENDERABLE_TYPES = new Set(['enum', 'integer', 'number', 'boolean', 'image-size'])

/** 本引擎需要读取的模型字段（PublicModelDto 的子集）。 */
export type ParameterCarrier = {
  parameters?: ParameterDescriptor[] | null
  defaults?: Record<string, unknown> | null
  maxCount?: number | null
  crossFieldConstraints?: ParameterCrossFieldConstraint[] | null
}

export interface DescriptorOption {
  value: ParameterValue
  label: string
  description?: string
  experimental?: boolean
  isDefault: boolean
}

export function findDescriptor(
  model: ParameterCarrier | null | undefined,
  name: string,
): ParameterDescriptor | undefined {
  return model?.parameters?.find((descriptor) => descriptor.name === name)
}

/** 按规范名查找 descriptor，容忍历史别名写法。 */
export function resolveDescriptor(
  model: ParameterCarrier | null | undefined,
  canonicalName: string,
): ParameterDescriptor | undefined {
  for (const name of new Set([canonicalName, ...(PARAM_ALIASES[canonicalName] ?? [])])) {
    const descriptor = findDescriptor(model, name)
    if (descriptor) return descriptor
  }
  return undefined
}

/** descriptor 的声明名 → 规范名（未知名称原样返回）。 */
export function canonicalNameOf(descriptor: Pick<ParameterDescriptor, 'name'>): string {
  return ALIAS_TO_CANONICAL[descriptor.name] ?? descriptor.name
}

/** 请求体里唯一写入的 key：模型自己声明的名字。 */
export function wireType(descriptor: Pick<ParameterDescriptor, 'name'>): string {
  return descriptor.name
}

const INTEGER_EXHAUSTIVE_MAX = 12
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
  // descriptor 默认值即使不在梯子上也必须可选（如 Seedance 默认 5 秒）。
  if (typeof descriptor.defaultValue === 'number' && Number.isInteger(descriptor.defaultValue)) {
    values.push(descriptor.defaultValue)
  }
  return [...new Set(values)]
    .sort((left, right) => left - right)
    .map((value) => ({ value, label: String(value), isDefault: value === descriptor.defaultValue }))
}

function numberOptions(descriptor: NumberParameterDescriptor): DescriptorOption[] {
  const suggested = [
    ...new Set([descriptor.min, descriptor.defaultValue].filter((value): value is number => typeof value === 'number')),
  ]
  return suggested.map((value) => ({ value, label: String(value), isDefault: value === descriptor.defaultValue }))
}

export function imageSizeOptions(descriptor: ImageSizeParameterDescriptor): DescriptorOption[] {
  return descriptor.presets.map((preset: ImageSizePreset) => ({
    value: preset.value,
    label: describeImageSize(preset),
    description: preset.description,
    experimental: preset.experimental,
    isDefault: preset.value === (descriptor.defaultValue ?? descriptor.presets[0]?.value),
  }))
}

/** descriptor 提供的全部可选值，保持 descriptor 自身的值类型。 */
export function descriptorOptions(descriptor: ParameterDescriptor | undefined): DescriptorOption[] {
  if (!descriptor) return []
  switch (descriptor.type) {
    case 'enum':
      return normalizeParameterOptions(descriptor.options as Array<string | ParameterOption>).map((option) => ({
        value: option.value,
        label: option.label ?? option.value,
        description: option.description,
        experimental: option.experimental,
        isDefault: option.value === descriptor.defaultValue,
      }))
    case 'integer':
      return integerOptions(descriptor)
    case 'number':
      return numberOptions(descriptor)
    case 'image-size':
      return imageSizeOptions(descriptor)
    case 'boolean':
      return [
        { value: true, label: '开', isDefault: descriptor.defaultValue === true },
        { value: false, label: '关', isDefault: descriptor.defaultValue === false },
      ]
    default:
      return []
  }
}

/** 把控件值强制成 descriptor 声明的 JSON 类型。 */
export function marshalDescriptorValue(
  descriptor: ParameterDescriptor,
  value: ParameterValue,
): ParameterValue {
  if (descriptor.type === 'integer' || descriptor.type === 'number') return Number(value)
  if (descriptor.type === 'boolean') return value === true || value === 'true'
  return String(value)
}

/** 初始展示值：descriptor 默认 → 模型 defaults → 调用方兜底。 */
export function descriptorDefault(
  model: ParameterCarrier | null | undefined,
  name: string,
  fallback: unknown,
): unknown {
  const descriptor = resolveDescriptor(model, name)
  if (descriptor && 'defaultValue' in descriptor && descriptor.defaultValue !== undefined) {
    return marshalDescriptorValue(descriptor, descriptor.defaultValue as ParameterValue)
  }
  const defaults = model?.defaults as Record<string, unknown> | undefined
  const names = new Set<string>([name, ...(descriptor ? [descriptor.name, canonicalNameOf(descriptor)] : [])])
  for (const alias of names) {
    const value = defaults?.[alias]
    if (value === undefined) continue
    return descriptor ? marshalDescriptorValue(descriptor, value as ParameterValue) : value
  }
  return fallback
}

export function isRenderableDescriptor(descriptor: ParameterDescriptor): boolean {
  return RENDERABLE_TYPES.has(descriptor.type)
}

/**
 * 当前应渲染的控件：已声明、可渲染、排除 `count`（单独展示单位）、
 * 且 `dependsOn` 依赖已满足。按 `ui.order` 排序。
 */
export function mediaControlDescriptors(
  model: ParameterCarrier | null | undefined,
  values?: ParameterState,
): ParameterDescriptor[] {
  const controls = (model?.parameters ?? []).filter((descriptor) => {
    if (!isRenderableDescriptor(descriptor)) return false
    if (canonicalNameOf(descriptor) === 'count') return false
    return isParameterVisible(descriptor, values)
  })
  const rank = (descriptor: ParameterDescriptor) => descriptor.ui?.order ?? Number.MAX_SAFE_INTEGER
  return [...controls].sort((left, right) => rank(left) - rank(right))
}

/** 控件标题：descriptor label → 同规范名的兄弟 label → 共享中文名 → key。 */
export function descriptorLabel(
  descriptor: ParameterDescriptor,
  model?: ParameterCarrier | null,
): string {
  if (descriptor.label) return descriptor.label
  const canonical = canonicalNameOf(descriptor)
  const sibling = model?.parameters?.find(
    (other) => other.name !== descriptor.name && canonicalNameOf(other) === canonical && Boolean(other.label),
  )
  if (sibling?.label) return sibling.label
  return CANONICAL_LABELS[canonical] ?? descriptor.name
}

export function isLegalValue(descriptor: ParameterDescriptor, value: ParameterValue): boolean {
  return validateParameterValue(descriptor, value as JsonValue).length === 0
}

/** 会阻断提交的问题列表（与 API 同一校验器，因此不会比服务端更松）。 */
export function parameterIssues(
  model: ParameterCarrier | null | undefined,
  values: ParameterState | undefined,
): Array<{ parameter: string; message: string }> {
  const issues: Array<{ parameter: string; message: string }> = []
  const effective: Record<string, JsonValue> = {}
  for (const descriptor of model?.parameters ?? []) {
    const picked = values?.[canonicalNameOf(descriptor)] ?? values?.[descriptor.name]
    if (picked === undefined) {
      const fallback = descriptorDefault(model, descriptor.name, undefined)
      if (fallback !== undefined) effective[descriptor.name] = fallback as JsonValue
      continue
    }
    if (!isParameterVisible(descriptor, values)) continue
    const marshalled = marshalDescriptorValue(descriptor, picked) as JsonValue
    effective[descriptor.name] = marshalled
    for (const issue of validateParameterValue(descriptor, marshalled)) {
      issues.push({ parameter: descriptor.name, message: issue.message })
    }
  }
  for (const issue of evaluateCrossFieldConstraints(model?.crossFieldConstraints ?? undefined, effective)) {
    issues.push({ parameter: issue.parameter, message: issue.message })
  }
  return issues
}

/** 控件应显示的值：用户选择仍合法则用它，否则用默认值。 */
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
 * 构造请求 `parameters`：遍历模型声明的 descriptor（而非用户 state 的 key），
 * 丢弃不合法/依赖不满足的值。切换模型后不会把旧模型的值发给新模型。
 */
export function buildMediaParameters(
  model: ParameterCarrier | null | undefined,
  state: ParameterState | undefined,
): ParameterState {
  const parameters: ParameterState = {}
  for (const descriptor of model?.parameters ?? []) {
    if (!isParameterVisible(descriptor, state)) continue
    const picked = state?.[canonicalNameOf(descriptor)] ?? state?.[descriptor.name]
    if (picked !== undefined && isLegalValue(descriptor, picked)) {
      parameters[wireType(descriptor)] = marshalDescriptorValue(descriptor, picked)
      continue
    }
    const fallback = descriptorDefault(model, descriptor.name, undefined)
    if (fallback !== undefined) {
      parameters[wireType(descriptor)] = marshalDescriptorValue(descriptor, fallback as ParameterValue)
    }
  }
  return parameters
}

/** 切换模型后把携带值收敛到新模型；纯函数、幂等，可在 effect 中安全调用。 */
export function reconcileModelParameters(
  model: ParameterCarrier | null | undefined,
  values: ParameterState | undefined,
): ParameterState {
  const descriptors = model?.parameters ?? []
  const declared: ParameterState = {}
  for (const descriptor of descriptors) {
    const value = values?.[canonicalNameOf(descriptor)] ?? values?.[descriptor.name]
    if (value !== undefined) declared[descriptor.name] = value
  }
  const reconciled = reconcileParameters(descriptors, declared)
  return Object.fromEntries(
    descriptors.flatMap((descriptor) =>
      descriptor.name in reconciled ? [[canonicalNameOf(descriptor), reconciled[descriptor.name]]] : [],
    ),
  )
}

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

export function asImageSizeDescriptor(
  descriptor: ParameterDescriptor | undefined,
): ImageSizeParameterDescriptor | undefined {
  return descriptor?.type === 'image-size' ? descriptor : undefined
}

export function sizeValues(descriptor: ImageSizeParameterDescriptor): string[] {
  return descriptor.presets.map((preset) => preset.value)
}

/** 自定义尺寸输入旁的约束提示。 */
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
    if (constraints.minPixels && constraints.maxPixels) hints.push(`总像素 ${format(constraints.minPixels)}–${format(constraints.maxPixels)}`)
    else if (constraints.maxPixels) hints.push(`总像素 ≤ ${format(constraints.maxPixels)}`)
    else if (constraints.minPixels) hints.push(`总像素 ≥ ${format(constraints.minPixels)}`)
  }
  if (constraints.maxAspectRatio) hints.push(`宽高比 ≤ ${constraints.maxAspectRatio}:1`)
  return hints
}

/** enum descriptor 的裸值列表。 */
export function optionValueList(descriptor: ParameterDescriptor | undefined): string[] {
  if (!descriptor || descriptor.type !== 'enum') return []
  return enumOptionValues(descriptor.options as Array<string | ParameterOption>)
}

export { AUTO_SIZE_VALUE, describeImageSize, parseImageSize, reduceRatio, isAdvancedParameter }
export type { ImageSizeConstraints, ImageSizePreset, ParameterDescriptor }
