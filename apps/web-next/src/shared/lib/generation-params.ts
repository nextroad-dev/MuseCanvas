// Browser-safe generation parameter normalization (no DOM, no Vue).
// Precedence: explicit user control > model parameter descriptor default >
// model legacy field/defaults > hardcoded fallback.

import type {
  InputSlotDescriptor,
  ModelConfig,
  ModelPricing,
  ParameterDescriptor,
  StagedReferenceImage,
  GenerationInputItem,
} from '@/shared/types'
import { modelMediaKind } from '@/shared/types'

export interface VideoControlState {
  durationSeconds: number
  aspectRatio: string
  resolution: string
  audio: boolean
  count: number
}

export interface ImageControlState {
  size: string
  quality: string
  count: number
}

export const VIDEO_DURATION_FALLBACK = [4, 6, 8]
export const VIDEO_ASPECT_FALLBACK = ['16:9', '9:16']
export const VIDEO_RESOLUTION_FALLBACK = ['720p', '1080p']
export const VIDEO_RESOLUTION_FULL = ['720p', '1080p', '4k']

export function findDescriptor(
  model: Pick<ModelConfig, 'parameters'> | null | undefined,
  name: string,
): ParameterDescriptor | undefined {
  return model?.parameters?.find((d) => d.name === name)
}

export function enumOptions(
  model: Pick<ModelConfig, 'parameters'> | null | undefined,
  name: string,
  fallback: string[],
): string[] {
  const d = findDescriptor(model, name)
  if (d && d.type === 'enum' && d.options.length > 0) return [...d.options]
  return [...fallback]
}

export function descriptorDefault(
  model: Pick<ModelConfig, 'parameters' | 'defaults'> | null | undefined,
  name: string,
  fallback: unknown,
): unknown {
  const d = findDescriptor(model, name)
  if (d && 'defaultValue' in d && d.defaultValue !== undefined) return d.defaultValue
  const fromDefaults = (model?.defaults as Record<string, unknown> | undefined)?.[name]
  if (fromDefaults !== undefined) return fromDefaults
  return fallback
}

function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : (value as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function toString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Allowed durations: descriptor options (numeric) take precedence over fallback. */
export function availableDurations(
  model: Pick<ModelConfig, 'parameters' | 'defaults'> | null | undefined,
): number[] {
  const d = findDescriptor(model, 'duration')
  if (d?.type === 'enum' && d.options.length > 0) {
    const parsed = d.options.map((o) => Number(o)).filter((n) => Number.isFinite(n))
    if (parsed.length > 0) return parsed
  }
  if (d?.type === 'integer') {
    const out: number[] = []
    for (const candidate of VIDEO_DURATION_FALLBACK) {
      if (d.min !== undefined && candidate < d.min) continue
      if (d.max !== undefined && candidate > d.max) continue
      out.push(candidate)
    }
    if (out.length > 0) return out
  }
  return [...VIDEO_DURATION_FALLBACK]
}

export function availableAspectRatios(
  model: Pick<ModelConfig, 'parameters' | 'defaults'> | null | undefined,
): string[] {
  return enumOptions(model, 'aspect_ratio', VIDEO_ASPECT_FALLBACK)
}

export function availableResolutions(
  model: Pick<ModelConfig, 'parameters' | 'defaults'> | null | undefined,
): string[] {
  const d = findDescriptor(model, 'resolution')
  if (d?.type === 'enum' && d.options.length > 0) return [...d.options]
  // "4k when advertised": only offer 4k if the descriptor explicitly lists it.
  return [...VIDEO_RESOLUTION_FALLBACK]
}

/** Normalize explicit video controls against model capabilities (precedence + clamping). */
export function normalizeVideoControls(
  model: Pick<ModelConfig, 'parameters' | 'defaults' | 'maxCount'> | null | undefined,
  explicit: Partial<VideoControlState>,
): VideoControlState {
  const durations = availableDurations(model)
  const aspects = availableAspectRatios(model)
  const resolutions = availableResolutions(model)
  const maxCount = model?.maxCount && model.maxCount > 0 ? model.maxCount : 1

  const rawDuration = explicit.durationSeconds ?? (descriptorDefault(model, 'duration', durations[0]) as number)
  const durationSeconds = durations.includes(toNumber(rawDuration, durations[0]))
    ? toNumber(rawDuration, durations[0])
    : durations[0]
  const rawAspect = toString(
    explicit.aspectRatio ?? (descriptorDefault(model, 'aspect_ratio', aspects[0]) as string),
    aspects[0],
  )
  const aspectRatio = aspects.includes(rawAspect) ? rawAspect : aspects[0]
  const rawResolution = toString(
    explicit.resolution ?? (descriptorDefault(model, 'resolution', resolutions[0]) as string),
    resolutions[0],
  )
  const resolution = resolutions.includes(rawResolution) ? rawResolution : resolutions[0]
  const audio = typeof explicit.audio === 'boolean'
    ? explicit.audio
    : (descriptorDefault(model, 'audio', true) as boolean) !== false
  const count = Math.min(Math.max(Math.floor(explicit.count ?? 1) || 1, 1), maxCount)
  return { durationSeconds, aspectRatio, resolution, audio, count }
}

/** Build the unified `parameters` payload for a video model. */
export function buildVideoParameters(state: VideoControlState): Record<string, unknown> {
  return {
    duration: state.durationSeconds,
    durationSeconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    aspectRatio: state.aspectRatio,
    resolution: state.resolution,
    audio: state.audio,
    count: state.count,
  }
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

export function maxInputCount(model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined): number {
  return resolveInputSlots(model).reduce((acc, slot) => acc + Math.max(0, slot.maxCount), 0)
}

export function supportsInputRole(
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined,
  role: string,
): boolean {
  const slots = resolveInputSlots(model)
  if (slots.length === 0) return false
  return slots.some((s) => s.role === role)
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
  return errors
}

export function estimateCredits(
  pricing: ModelPricing | undefined,
  legacyCreditsPerImage: number | undefined,
  opts: { count: number; durationSeconds?: number; optimizationCredits?: number },
): number {
  const opt = opts.optimizationCredits ?? 0
  const count = Math.max(1, Math.floor(opts.count) || 1)
  if (!pricing) return (legacyCreditsPerImage ?? 0) * count + opt
  if (pricing.scheme === 'per_second_v1') {
    const seconds = Math.max(0, opts.durationSeconds ?? 0)
    return Math.ceil(pricing.creditsPerSecond * seconds * count) + opt
  }
  return pricing.creditsPerImage * count + opt
}

/** Quote helper that picks per-second vs per-image pricing by model kind. */
export function estimateModelCredits(
  model: Pick<ModelConfig, 'modelKind' | 'mediaKind' | 'pricing' | 'creditsPerImage'> | null | undefined,
  opts: { count: number; durationSeconds?: number; optimizationCredits?: number },
): number {
  if (modelMediaKind(model as ModelConfig) === 'video' || model?.pricing?.scheme === 'per_second_v1') {
    return estimateCredits(model?.pricing, model?.creditsPerImage, opts)
  }
  return estimateCredits(
    model?.pricing?.scheme === 'per_image_v1' ? model.pricing : undefined,
    model?.creditsPerImage ?? 0,
    opts,
  )
}
