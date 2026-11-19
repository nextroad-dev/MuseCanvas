// 生成参数解析与请求体构造。纯模块（仅 type import + 本地常量），可被
// `node --test` 直接加载；描述符驱动的控件构建见 `media-parameters.ts`。
//
// 分工：本文件负责「画幅/张数/时长等参数值 → 规范化请求体」，
// 不复制后端 descriptor 校验规则（合法性由 contracts 校验器与 API 共同保证）。

import type { GenerationInputItem } from '@musecanvas/contracts'

export const DEFAULT_GENERATION_COUNT = 1
/** generation_jobs.max_count 的历史 CHECK 上限（1..10）。 */
export const MAX_GENERATION_COUNT = 10
export const MIN_GENERATION_COUNT = 1
/** 视频时长上限兜底：真实上限由模型 descriptor 的 max 决定。 */
export const MAX_VIDEO_DURATION_SECONDS = 60

export interface ParsedSize {
  width: number
  height: number
  /** 约分后的宽高比，如 `3:4`。 */
  ratio: string
}

export interface ParsedGenerationParams {
  /** 原始尺寸字符串（如 `3:4`、`1024x1365`、`auto`），无则 null。 */
  size: string | null
  aspectRatio: string | null
  count: number
  quality: string | null
  durationSeconds: number | null
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** 约分宽高比；非法尺寸返回 null。 */
export function reduceRatio(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const factor = gcd(Math.round(width), Math.round(height))
  return `${Math.round(width) / factor}:${Math.round(height) / factor}`
}

/** 解析尺寸描述：`1024x1365` 或带比例前缀的 `3:4`（返回 null 宽度/高度）。 */
export function parseSize(value: unknown): ParsedSize | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'auto') return null
  const dimension = trimmed.match(/^(\d{1,5})\s*[x×]\s*(\d{1,5})$/i)
  if (dimension) {
    const width = Number(dimension[1])
    const height = Number(dimension[2])
    if (width <= 0 || height <= 0) return null
    return { width, height, ratio: reduceRatio(width, height) ?? `${width}:${height}` }
  }
  return null
}

/** 从 `3:4` 形式解析宽高比；非法返回 null。 */
export function parseAspectRatio(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{1,4})\s*[:/]\s*(\d{1,4})$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return null
  return `${width}:${height}`
}

export function normalizeCount(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return DEFAULT_GENERATION_COUNT
  const rounded = Math.trunc(numeric)
  return Math.min(MAX_GENERATION_COUNT, Math.max(MIN_GENERATION_COUNT, rounded))
}

export function parseDurationSeconds(value: unknown): number | null {
  const numeric =
    typeof value === 'string'
      ? Number(value.trim().replace(/s$/i, ''))
      : typeof value === 'number'
        ? value
        : NaN
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  const rounded = Math.round(numeric)
  return rounded > MAX_VIDEO_DURATION_SECONDS ? MAX_VIDEO_DURATION_SECONDS : rounded
}

/**
 * 解析任务 DTO 或参数袋中的画幅/张数/时长。
 * 兼容 `parameters.size` / `size`、`durationSeconds`/`duration`、`aspectRatio`/`ratio`。
 */
export function parseGenerationParams(
  source:
    | {
        parameters?: Record<string, unknown> | null
        size?: string | null
        quality?: string | null
        count?: number | null
      }
    | null
    | undefined,
): ParsedGenerationParams {
  const parameters = source?.parameters ?? {}
  const pickedSize =
    (typeof parameters.size === 'string' ? parameters.size : undefined) ??
    (typeof parameters.aspect_ratio === 'string' ? parameters.aspect_ratio : undefined) ??
    (typeof source?.size === 'string' ? source.size : undefined) ??
    null
  const parsedSize = parseSize(pickedSize)
  const aspectRatio =
    parseAspectRatio(pickedSize) ??
    parseAspectRatio(parameters.aspectRatio) ??
    parseAspectRatio(parameters.aspect_ratio) ??
    parsedSize?.ratio ??
    null
  const quality =
    (typeof parameters.quality === 'string' ? parameters.quality : undefined) ??
    (typeof source?.quality === 'string' ? source.quality : undefined) ??
    null
  const durationSeconds =
    parseDurationSeconds(parameters.durationSeconds) ??
    parseDurationSeconds(parameters.duration) ??
    parseDurationSeconds(parameters.duration_s)
  const count = normalizeCount(parameters.count ?? source?.count)
  return { size: pickedSize, aspectRatio, count, quality, durationSeconds }
}

/** 结果卡副标题：`3:4 · 1024 × 1365 · 1 张`，缺失项自动省略。 */
export function formatSizeLabel(size: string | null | undefined, count?: number): string {
  const parsed = parseSize(size)
  const ratio = parsed?.ratio ?? parseAspectRatio(size) ?? (size && size !== 'auto' ? size : null)
  const dimensions = parsed ? `${parsed.width} × ${parsed.height}` : null
  const pieces = [ratio, dimensions].filter((piece): piece is string => Boolean(piece))
  if (count !== undefined && count > 1) pieces.push(`${count} 张`)
  return pieces.join(' · ') || '默认画幅'
}

/** 输入项规范化：只保留 ready 的引用、按顺序重排 position。 */
export function buildGenerationInputs(
  inputs:
    | ReadonlyArray<{
        uploadId?: string | null
        assetId?: string | null
        role?: string | null
        position?: number | null
      }>
    | null
    | undefined,
): GenerationInputItem[] {
  if (!inputs) return []
  const normalized: GenerationInputItem[] = []
  for (const item of inputs) {
    const uploadId = item.uploadId || undefined
    const assetId = item.assetId || undefined
    if (!uploadId && !assetId) continue
    normalized.push({
      ...(uploadId ? { uploadId } : { assetId: assetId as string }),
      role: (item.role || 'reference_image') as GenerationInputItem['role'],
      position: normalized.length,
    })
  }
  return normalized
}

/** 去掉 undefined/null 的参数值；空对象整体省略。 */
export function normalizeParameters(
  parameters: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!parameters) return undefined
  const output: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value
    }
  }
  return Object.keys(output).length > 0 ? output : undefined
}

/** 新请求的幂等键：优先 crypto.randomUUID，环境不支持时退化为时间戳随机串。 */
export function newIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return randomUuid
  return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
