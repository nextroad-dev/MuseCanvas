// Multipart transport for the admin plugin upload/validate endpoints, plus the
// small display helpers the plugin section needs.
//
// Why this is not `api()`: `clientApi` (src/shared/services/client-api.ts) always
// JSON-stringifies `body` and pins `Content-Type: application/json`, so it cannot
// carry FormData. Rather than rewrite the shared client, this helper replicates
// only its URL/base resolution and its status-agnostic JSON parsing, and keeps the
// same envelope contract (`ApiResponse<T>`). Envelope detail that matters here: a
// scan rejection answers HTTP 422 but is built with the server's `ok()` helper
// (`rejected()` in apps/api/src/modules/admin/plugins.ts), so it arrives as
// `{ success: true, data: { installed: false, ok: false, code, findings } }` —
// findings must be read from `res.data`; `res.error` only carries `fail()` codes.
import type { ApiResponse } from '@/shared/types'

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

/**
 * Cap for one uploaded `.mjs` artifact, mirroring `PLUGIN_ARTIFACT_MAX_BYTES` in
 * `packages/providers/src/core/plugin-scan.ts` (5_242_880). Kept as a local literal
 * because web-next depends only on `@musecanvas/contracts` (see the webpack alias in
 * next.config.mjs); the server remains the authority — it enforces the cap on the
 * decoded bytes in `readPluginPackage` (`apps/api/src/modules/admin/plugins.ts`).
 */
export const PLUGIN_ARTIFACT_MAX_BYTES = 5_242_880

export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Short sha256 label; the full digest belongs in a `title`. */
export function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest
}

/**
 * POST `multipart/form-data` with exactly the two fields the server accepts
 * (`readPluginPackage` rejects any extra key, and requires one `manifest` string
 * plus one `.mjs` `file`). Returns the parsed envelope; on a network failure or a
 * non-JSON body (nginx error page) it degrades to `{ success: false }` like clientApi.
 */
export async function postPluginPackage<T>(
  path: string,
  manifestText: string,
  file: File,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  const relativeUrl = new URL(path, origin).pathname
  const requestUrl = BASE_URL.endsWith('/api') && relativeUrl.startsWith('/api/')
    ? BASE_URL + relativeUrl.slice(4)
    : BASE_URL + relativeUrl

  const form = new FormData()
  form.append('manifest', manifestText)
  form.append('file', file, file.name)

  try {
    // No Content-Type header on purpose: the browser generates `multipart/form-data`
    // together with the boundary. `credentials: 'include'` matches clientApi so the
    // HttpOnly session cookie rides along through the same-origin proxy.
    const res = await fetch(requestUrl, { method: 'POST', body: form, credentials: 'include', signal })
    const text = await res.text()
    if (!text) {
      return { success: false, error: { code: `HTTP_${res.status}`, message: '上游服务响应异常' } }
    }
    try {
      return JSON.parse(text) as ApiResponse<T>
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
