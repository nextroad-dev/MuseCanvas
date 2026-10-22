import type { MediaModelDefaultsDto, UpdateMediaModelDefaultsRequest } from '@musecanvas/contracts'
import type { AdminModel, ApiResponse } from '@/shared/types'

export type MediaDefaultKind = 'image' | 'video'

export const MEDIA_MODEL_DEFAULTS_QUERY_KEY = ['admin', 'media-model-defaults'] as const
export const PUBLIC_MODELS_QUERY_KEY = ['models'] as const

export const MEDIA_DEFAULT_KIND_LABEL: Record<MediaDefaultKind, string> = {
  image: '图像',
  video: '视频',
}

/** Media kind of an admin row; language rows never appear here, fall back to image. */
export function mediaDefaultKindOf(model: Pick<AdminModel, 'modelKind' | 'mediaKind'>): MediaDefaultKind {
  if (model.modelKind === 'video' || model.mediaKind === 'video') return 'video'
  return 'image'
}

/** Only enabled rows of the kind are electable as default (server rejects the rest). */
export function enabledModelsByKind(models: AdminModel[], kind: MediaDefaultKind): AdminModel[] {
  return models.filter((model) => mediaDefaultKindOf(model) === kind && model.enabled)
}

export function defaultIdForKind(
  defaults: MediaModelDefaultsDto | null | undefined,
  kind: MediaDefaultKind,
): string | null {
  if (!defaults) return null
  return kind === 'image' ? defaults.imageModelId : defaults.videoModelId
}

export function isModelDefault(
  modelId: string,
  defaults: MediaModelDefaultsDto | null | undefined,
): boolean {
  if (!defaults) return false
  return defaults.imageModelId === modelId || defaults.videoModelId === modelId
}

/** Single-kind PATCH body; absent key leaves the other kind untouched (server contract). */
export function defaultsPatchForKind(kind: MediaDefaultKind, id: string): UpdateMediaModelDefaultsRequest {
  return kind === 'image' ? { imageModelId: id } : { videoModelId: id }
}

/** Kind-aware copy for the 409 guard on disable/delete (server code DEFAULT_MODEL_IN_USE). */
export function defaultInUseMessage(kind: MediaDefaultKind): string {
  return `这是当前默认的${MEDIA_DEFAULT_KIND_LABEL[kind]}模型，请先指定其他默认模型`
}

/** Rewrite a generic DEFAULT_MODEL_IN_USE failure into the kind-aware copy for this view. */
export function rewriteDefaultInUseError(
  error: { code?: string; message?: string } | null | undefined,
  kind: MediaDefaultKind,
  fallback: string,
): string {
  if (error?.code === 'DEFAULT_MODEL_IN_USE') return defaultInUseMessage(kind)
  return error?.message?.trim() || fallback
}

const DEFAULTS_SAVE_ERRORS: Record<string, string> = {
  DEFAULT_MODEL_INVALID: '所选模型不可用：可能已停用、已删除或类型不符，请重新选择。',
  DEFAULT_MODEL_IN_USE: '该模型是当前默认模型，请先指定其他默认模型后再操作。',
  INVALID_INPUT: '提交的默认模型超出服务端允许范围，请重新选择后重试。',
  FORBIDDEN: '仅管理员可以修改默认模型。',
}

/** Server/transport error -> copy that names the actual cause instead of a generic failure. */
export function defaultsSaveError(
  error: { code?: string; message?: string } | null | undefined,
  fallback = '保存默认模型失败',
): string {
  const mapped = error?.code ? DEFAULTS_SAVE_ERRORS[error.code] : undefined
  if (mapped) return mapped
  return error?.message?.trim() || fallback
}

export type MediaDefaultsFetcher = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<ApiResponse<MediaModelDefaultsDto>>

/**
 * Thin PATCH wrapper (method is PATCH: dispatchPut 404s on this path).
 * Keeps the error code on the thrown Error so callers can map DEFAULT_MODEL_* copy.
 */
export async function patchMediaModelDefaults(
  fetcher: MediaDefaultsFetcher,
  path: string,
  patch: UpdateMediaModelDefaultsRequest,
): Promise<MediaModelDefaultsDto> {
  const res = await fetcher(path, { method: 'PATCH', body: patch })
  if (!res.success || res.data == null) {
    throw Object.assign(new Error(res.error?.message || '保存默认模型失败'), {
      code: res.error?.code || 'INVALID_RESPONSE',
    })
  }
  return res.data
}
