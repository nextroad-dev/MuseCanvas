// Browser-safe generation parameter normalization (no DOM, no Vue).
// Precedence: explicit user control > model parameter descriptor default >
// model legacy field/defaults > hardcoded fallback.
//
// The server-side domain validator rejects (1) any parameter key the model does
// not declare and (2) any value whose JSON type does not match its descriptor,
// so every payload built here is descriptor-driven: keys come from
// `wireType(descriptor)` and values from `marshalDescriptorValue`.

import type {
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  ModelConfig,
  ParameterDescriptor,
  StagedReferenceImage,
  GenerationInputItem,
} from '@/shared/types'
import { RUNTIME_SETTINGS_DEFAULTS, isVideoModel } from '@/shared/types'

export interface ImageControlState {
  size: string
  quality: string
  count: number
}

/**
 * Canonical parameter name -> accepted descriptor names (canonical first).
 * Real presets use camelCase (`durationSeconds`), older helpers looked up
 * `duration` / `aspect_ratio`; the alias table keeps both spellings readable
 * while `wireType()` guarantees only the declared name ever reaches the API.
 */
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

/** Duration ladder for integer descriptors whose range is too wide to enumerate. */
const DURATION_LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 60]
/** Below this many integers in range, enumerate exhaustively instead of using the ladder. */
const INTEGER_EXHAUSTIVE_MAX = 12

const CANONICAL_LABELS: Record<string, string> = {
  durationSeconds: '时长（秒）',
  aspectRatio: '宽高比',
  resolution: '分辨率',
  audio: '生成音频',
  count: '生成数量',
}

const CONTROL_ORDER: Record<string, number> = {
  durationSeconds: 0,
  aspectRatio: 1,
  resolution: 2,
  audio: 3,
}

const SLOT_ORDER: Record<string, number> = {
  first_frame: 0,
  last_frame: 1,
  reference_image: 2,
}

const ROLE_LABELS: Record<string, string> = {
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_image: '参考图',
  prompt_image: '提示图',
  source_video: '源视频',
}

/** Roles never renderable as staged images: the upload endpoint accepts
 *  image/png and image/jpeg only. */
const UNSUPPORTED_PLAN_ROLES = new Set<string>(['source_video'])

export function findDescriptor(
  model: Pick<ModelConfig, 'parameters'> | null | undefined,
  name: string,
): ParameterDescriptor | undefined {
  return model?.parameters?.find((d) => d.name === name)
}

/** Look a descriptor up by canonical name, tolerating legacy alias spellings. */
export function resolveDescriptor(
  model: Pick<ModelConfig, 'parameters'> | null | undefined,
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
export function canonicalNameOf(descriptor: ParameterDescriptor): string {
  return ALIAS_TO_CANONICAL[descriptor.name] ?? descriptor.name
}

/** The single key we ever put on the wire: whatever the model declared. */
export function wireType(descriptor: Pick<ParameterDescriptor, 'name'>): string {
  return descriptor.name
}

export interface DescriptorOption {
  /** Stays in the descriptor's own value type: enum options are verbatim strings
   *  (`'8'` for Veo durations), integer options are numbers, boolean are booleans.
   *  Feed it straight back into `marshalDescriptorValue` / the state map. */
  value: string | number | boolean
  label: string
  isDefault: boolean
}

/** Every value a descriptor accepts, in the descriptor's own value type.
 *  Enum options stay verbatim strings (Veo's duration is `'8'`, not `8`). */
export function descriptorOptions(d: ParameterDescriptor | undefined): DescriptorOption[] {
  if (!d) return []
  if (d.type === 'enum') {
    return d.options.map((value) => ({
      value,
      label: value,
      isDefault: value === d.defaultValue,
    }))
  }
  if (d.type === 'integer') {
    return integerOptions(d)
  }
  if (d.type === 'boolean') {
    const active = d.defaultValue ?? true
    return [
      { value: true, label: '开', isDefault: active === true },
      { value: false, label: '关', isDefault: active === false },
    ]
  }
  return []
}

function integerOptions(d: IntegerParameterDescriptor): DescriptorOption[] {
  const step = d.step !== undefined && d.step > 0 ? Math.trunc(d.step) : 1
  const hasMin = d.min !== undefined
  const hasMax = d.max !== undefined
  const span = hasMin && hasMax ? (d.max as number) - (d.min as number) + 1 : Number.POSITIVE_INFINITY
  const values: number[] = []
  if (span <= INTEGER_EXHAUSTIVE_MAX) {
    for (let value = d.min as number; value <= (d.max as number); value += step) values.push(value)
  } else {
    const base = hasMin ? (d.min as number) : 0
    for (const candidate of DURATION_LADDER) {
      if (hasMin && candidate < (d.min as number)) continue
      if (hasMax && candidate > (d.max as number)) continue
      if ((candidate - base) % step !== 0) continue
      values.push(candidate)
    }
  }
  const defaultValue = d.defaultValue
  // The descriptor's own default must always be selectable even when it sits
  // off-ladder (Seedance defaults to 5s, which no curated ladder contained).
  if (typeof defaultValue === 'number' && Number.isInteger(defaultValue)) values.push(defaultValue)
  return [...new Set(values)]
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: String(value), isDefault: value === defaultValue }))
}

/** Coerce a picked value into the JSON type the descriptor declares.
 *  This is what lets Veo (string enum) and Seedance (integer) share one control. */
export function marshalDescriptorValue(
  d: ParameterDescriptor,
  raw: string | number | boolean,
): string | number | boolean {
  if (d.type === 'integer') return Number(raw)
  if (d.type === 'boolean') return raw === true || raw === 'true'
  return String(raw)
}

export function descriptorDefault(
  model: Pick<ModelConfig, 'parameters' | 'defaults'> | null | undefined,
  name: string,
  fallback: unknown,
): unknown {
  const descriptor = resolveDescriptor(model, name)
  const names = new Set<string>([
    ...(descriptor ? [descriptor.name, name, canonicalNameOf(descriptor)] : [name]),
  ])
  const defaults = model?.defaults as Record<string, unknown> | undefined
  if (descriptor && 'defaultValue' in descriptor && descriptor.defaultValue !== undefined) {
    return marshalDescriptorValue(descriptor, descriptor.defaultValue as string | number | boolean)
  }
  for (const alias of names) {
    const fromDefaults = defaults?.[alias]
    if (fromDefaults !== undefined) {
      return descriptor
        ? marshalDescriptorValue(descriptor, fromDefaults as string | number | boolean)
        : fromDefaults
    }
  }
  return fallback
}

/** Video controls: declared descriptors minus `count` (rendered separately)
 *  minus free text, ordered duration -> aspect ratio -> resolution -> audio. */
export function videoControlDescriptors(
  model: Pick<ModelConfig, 'parameters'> | null | undefined,
): ParameterDescriptor[] {
  const controls = (model?.parameters ?? []).filter((d) => {
    if (d.type === 'text') return false
    const canonical = canonicalNameOf(d)
    return canonical !== 'count' && d.name !== 'count'
  })
  const rank = (d: ParameterDescriptor) => CONTROL_ORDER[canonicalNameOf(d)] ?? Number.MAX_SAFE_INTEGER
  return controls.sort((a, b) => rank(a) - rank(b))
}

/** Human label for a descriptor: its own label, else the canonical Chinese name. */
export function descriptorLabel(
  d: ParameterDescriptor,
  model?: Pick<ModelConfig, 'parameters'> | null,
): string {
  if (d.label) return d.label
  const canonical = canonicalNameOf(d)
  const sibling = model?.parameters?.find(
    (other) => other.name !== d.name && canonicalNameOf(other) === canonical && !!other.label,
  )
  if (sibling?.label) return sibling.label
  return CANONICAL_LABELS[canonical] ?? d.name
}

/** Build the unified `parameters` payload for a video model.
 *  Iterates the model's descriptors, never the user's state keys: only declared
 *  names go on the wire and every value matches its descriptor's type. A control
 *  with neither a user value nor a default is omitted so the server applies its own. */
export function buildVideoParameters(
  model: Pick<ModelConfig, 'parameters' | 'defaults' | 'maxCount'> | null | undefined,
  state: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const parameters: Record<string, string | number | boolean> = {}
  for (const d of model?.parameters ?? []) {
    const canonical = canonicalNameOf(d)
    const picked = state[canonical] ?? state[d.name]
    if (picked !== undefined) {
      parameters[wireType(d)] = marshalDescriptorValue(d, picked)
      continue
    }
    const fallback = descriptorDefault(model, d.name, undefined)
    if (fallback === undefined) continue
    parameters[wireType(d)] = marshalDescriptorValue(d, fallback as string | number | boolean)
  }
  return parameters
}

/** Build the unified `parameters` payload for a legacy image model. */
export function buildImageParameters(state: ImageControlState): Record<string, unknown> {
  return { size: state.size, quality: state.quality, count: state.count }
}

/** Effective input slots: descriptor slots win; otherwise derive from maxInputImages. */
export function resolveInputSlots(
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined,
): InputSlotDescriptor[] {
  if (model?.inputSlots && model.inputSlots.length > 0) return model.inputSlots
  const max = model?.maxInputImages ?? 0
  if (max <= 0) return []
  return [{
    role: 'reference_image',
    required: false,
    minCount: 0,
    maxCount: max,
    allowedMediaKinds: ['image'],
  }]
}

/** Anything an input plan needs: a full model, or the legacy 2-key pick already
 *  used by the reference-image call sites (an absent `modelKind` reads as image). */
export type ImageInputPlanModel =
  Partial<Pick<ModelConfig, 'modelKind' | 'mediaKind'>> & Pick<ModelConfig, 'inputSlots' | 'maxInputImages'>

export interface ImageInputPlan {
  slots: InputSlotDescriptor[]
  capacity: number
  multiRole: boolean
}

/** Image-only view of a model's input slots: which roles may be staged, in what
 *  positional order, and how many files fit. */
export function resolveImageInputPlan(model: ImageInputPlanModel | null | undefined): ImageInputPlan {
  const videoKind = isVideoModel({
    modelKind: model?.modelKind ?? 'image',
    mediaKind: model?.mediaKind,
  })
  const slots = resolveInputSlots(model).filter((slot) => {
    if (slot.allowedMediaKinds.length > 0 && !slot.allowedMediaKinds.includes('image')) return false
    if (UNSUPPORTED_PLAN_ROLES.has(slot.role)) return false
    // Both video providers infer frame roles positionally, so mixing references
    // with first/last frames is not representable in either request shape.
    if (videoKind && slot.role === 'reference_image') return false
    return true
  })
  const ordered = [...slots].sort(
    (a, b) => (SLOT_ORDER[a.role] ?? Number.MAX_SAFE_INTEGER) - (SLOT_ORDER[b.role] ?? Number.MAX_SAFE_INTEGER),
  )
  const total = ordered.reduce((sum, slot) => sum + Math.max(0, slot.maxCount), 0)
  const capacity = Math.max(0, Math.min(total, RUNTIME_SETTINGS_DEFAULTS.maxInputs))
  return {
    slots: ordered,
    capacity,
    multiRole: new Set(ordered.map((slot) => slot.role)).size > 1,
  }
}

/** Positional role for every accepted slot: a slot with `maxCount: n` contributes
 *  n positions, so staged order alone decides roles. */
export function planRolePositions(plan: ImageInputPlan): string[] {
  const positions: string[] = []
  for (const slot of plan.slots) {
    const repeats = Math.max(0, slot.maxCount)
    for (let index = 0; index < repeats; index += 1) positions.push(slot.role)
  }
  return positions.slice(0, plan.capacity)
}

/** Staged uploads -> unified inputs[] with stable positions. */
export function buildGenerationInputs(
  staged: Pick<StagedReferenceImage, 'uploadId' | 'status' | 'role'>[],
): GenerationInputItem[] {
  return staged
    .filter((img) => img.status === 'ready' && img.uploadId)
    .map((img, index) => ({
      uploadId: img.uploadId as string,
      role: (img.role || 'reference_image') as GenerationInputItem['role'],
      position: index,
    }))
}

/** First/last-frame constraints: at most one each; first must lead, last must trail. */
export function firstLastFrameViolations(
  staged: Pick<StagedReferenceImage, 'role'>[],
  plan?: ImageInputPlan | null,
): string[] {
  const errors: string[] = []
  const firstIdx: number[] = []
  const lastIdx: number[] = []
  staged.forEach((img, i) => {
    if (img.role === 'first_frame') firstIdx.push(i)
    if (img.role === 'last_frame') lastIdx.push(i)
  })
  if (firstIdx.length > 1) errors.push('只能设置一张首帧图片')
  if (lastIdx.length > 1) errors.push('只能设置一张尾帧图片')
  if (firstIdx.length === 1 && firstIdx[0] !== 0) errors.push('首帧图片必须放在第一位')
  if (lastIdx.length === 1 && lastIdx[0] !== staged.length - 1) errors.push('尾帧图片必须放在最后一位')
  if (firstIdx.length === 1 && lastIdx.length === 1 && staged.length < 2) {
    errors.push('首帧与尾帧不能是同一张图片')
  }
  if (lastIdx.length > 0 && firstIdx.length === 0) errors.push('设置尾帧前请先设置首帧')
  if (plan) errors.push(...roleCountViolations(staged, plan))
  return errors
}

function roleCountViolations(
  staged: Pick<StagedReferenceImage, 'role'>[],
  plan: ImageInputPlan,
): string[] {
  const errors: string[] = []
  const counts = new Map<string, number>()
  for (const img of staged) {
    if (!img.role) continue
    counts.set(img.role, (counts.get(img.role) ?? 0) + 1)
  }
  for (const [role, count] of counts) {
    const slot = plan.slots.find((candidate) => candidate.role === role)
    const label = slot?.label ?? ROLE_LABELS[role] ?? role
    if (!slot) {
      errors.push(`当前模型不支持${label}，请移除该图片`)
      continue
    }
    // A single first/last frame is already covered by the dedicated rules above.
    if ((role === 'first_frame' || role === 'last_frame') && slot.maxCount <= 1) continue
    if (count > slot.maxCount) errors.push(`${label}最多设置 ${slot.maxCount} 张（当前 ${count} 张）`)
  }
  return errors
}

/** Everything that blocks submission for the staged images under a plan. */
export function inputPlanViolations(
  staged: Pick<StagedReferenceImage, 'role'>[],
  plan: ImageInputPlan,
): string[] {
  const errors: string[] = []
  if (staged.length > plan.capacity) {
    errors.push(
      plan.capacity === 0
        ? '当前模型不支持输入图片，请切换到支持图片输入的模型'
        : `当前模型最多接受 ${plan.capacity} 张输入图片（已暂存 ${staged.length} 张）`,
    )
  }
  for (const message of firstLastFrameViolations(staged, plan)) errors.push(message)
  return [...new Set(errors)]
}
