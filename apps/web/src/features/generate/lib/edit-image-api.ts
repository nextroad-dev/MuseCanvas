// Multipart transport for 局部修改 (`POST /api/images/edit`).
//
// Why this is not `clientApi`: that client always pins `content-type:
// application/json` and `JSON.stringify`s the body (src/shared/services/
// client-api.ts), so it cannot carry FormData. This replicates
// `postPluginPackage` in src/features/admin/lib/plugin-upload.ts — the same base
// resolution, the same status-agnostic envelope parse — and nothing else.
//
// The request references the source by `assetId` and describes the region as
// numbers, so no image bytes travel: every image this screen edits is already an
// `assets` row (a job output or a library pick), and re-uploading it would create
// a second object for a picture the server already has.
import { API_ENDPOINTS, editSelectionIsUsable } from '@musecanvas/contracts'
import type { EditSelection } from '@musecanvas/contracts'
import type { ApiResponse, GenerationJob } from '@/shared/types'

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

export interface ImageEditRequest {
  modelId: string
  /** The user's own words, sent verbatim. The server is what wraps them in the
   *  mask-respecting instruction, so pre-wrapping here would double it. */
  prompt: string
  /** `assets.id` of the image being edited. Exactly one source, so `image` (the
   *  file-part branch) is never sent alongside it. */
  assetId: string
  /** Source-image pixels, as committed by the stage. */
  selection: EditSelection
  /**
   * The unified parameter bag, mirroring `POST /api/generations`. Carries every
   * declared control the console still shows (`quality`, `background`,
   * `output_format`, …) so none of them is silently ignored. `size` and `count`
   * belong to the server on this route and are overwritten there.
   */
  parameters?: Record<string, unknown>
  quality?: string
  idempotencyKey?: string
}

/**
 * `multipart/form-data` with `assetId` + `region`. Returns the parsed envelope —
 * the same `GenerationJob` DTO as `POST /api/generations` on success (HTTP 202),
 * `{ success: false, error }` on failure — because the server answers both with
 * JSON and `success` is the only truth, not the status code.
 */
export async function postImageEdit(
  request: ImageEditRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<GenerationJob>> {
  if (!editSelectionIsUsable(request.selection)) {
    return { success: false, error: { code: 'INVALID_SELECTION', message: '请先在图片上框选要修改的区域' } }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  const relativeUrl = new URL(API_ENDPOINTS.images.edit, origin).pathname
  const requestUrl = BASE_URL.endsWith('/api') && relativeUrl.startsWith('/api/')
    ? BASE_URL + relativeUrl.slice(4)
    : BASE_URL + relativeUrl

  const form = new FormData()
  form.append('modelId', request.modelId)
  form.append('prompt', request.prompt)
  if (request.parameters && Object.keys(request.parameters).length > 0) {
    form.append('parameters', JSON.stringify(request.parameters))
  }
  if (request.quality) form.append('quality', request.quality)
  if (request.idempotencyKey) form.append('idempotencyKey', request.idempotencyKey)
  form.append('assetId', request.assetId)
  form.append('region', JSON.stringify({
    x: request.selection.x,
    y: request.selection.y,
    width: request.selection.width,
    height: request.selection.height,
  }))

  try {
    // No Content-Type on purpose: the browser has to generate
    // `multipart/form-data` together with its boundary. `credentials: 'include'`
    // matches clientApi, so the HttpOnly session cookie rides along through the
    // same-origin proxy.
    const res = await fetch(requestUrl, { method: 'POST', body: form, credentials: 'include', signal })
    const text = await res.text()
    if (!text) {
      return { success: false, error: { code: `HTTP_${res.status}`, message: '上游服务响应异常' } }
    }
    try {
      return JSON.parse(text) as ApiResponse<GenerationJob>
    } catch {
      return { success: false, error: { code: `HTTP_${res.status}`, message: '上游服务响应异常' } }
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: { code: 'ABORTED', message: '请求已取消' } }
    }
    return { success: false, error: { code: 'NETWORK_ERROR', message: '网络连接失败' } }
  }
}
