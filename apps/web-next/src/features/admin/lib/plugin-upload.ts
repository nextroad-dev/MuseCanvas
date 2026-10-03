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
import type { AdminPluginScanFinding, ApiResponse } from '@/shared/types'

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

/**
 * Resolve an `API_ENDPOINTS` path the same way clientApi does: a relative `/api/...`
 * path through the same-origin Next.js proxy, or `NEXT_PUBLIC_API_BASE_URL` when one
 * is configured. Used for the multipart POST below and for plain `<img src>` /
 * `<a href>` targets (plugin icon, package download) that the browser fetches itself
 * with the session cookie.
 */
export function resolveApiUrl(path: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  const relativeUrl = new URL(path, origin).pathname
  return BASE_URL.endsWith('/api') && relativeUrl.startsWith('/api/')
    ? BASE_URL + relativeUrl.slice(4)
    : BASE_URL + relativeUrl
}

/**
 * Cap for one uploaded plugin `.zip` package (spec section 2.2: zip itself <= 6 MiB).
 * Local literal for the same reason as PLUGIN_ARTIFACT_MAX_BYTES below; the server
 * remains the authority and enforces it on the received bytes.
 */
export const PLUGIN_PACKAGE_MAX_BYTES = 6_291_456

/**
 * Cap for the entry `.mjs` bundle inside a package, mirroring `PLUGIN_ARTIFACT_MAX_BYTES` in
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
 * Location label of a scan finding: `path:line:column`, degrading to whichever parts
 * are present (`path`, `path:line`, or `行 line:column` for legacy path-less
 * findings). Returns null when the finding carries no location at all.
 */
export function formatFindingLocation(f: Pick<AdminPluginScanFinding, 'path' | 'line' | 'column'>): string | null {
  const hasLine = typeof f.line === 'number'
  const hasColumn = hasLine && typeof f.column === 'number'
  if (!f.path && !hasLine) return null
  const parts: string[] = []
  if (f.path) parts.push(f.path)
  if (hasLine) parts.push(String(f.line))
  if (hasColumn) parts.push(String(f.column))
  // Without a path the bare `12:4` reads poorly; prefix a label instead.
  return f.path ? parts.join(':') : `行 ${parts.join(':')}`
}

/** Group findings by package path, keeping first-seen order; path-less findings go under `null` (package level). */
export function groupFindingsByPath(findings: AdminPluginScanFinding[]): { path: string | null; findings: AdminPluginScanFinding[] }[] {
  const groups = new Map<string | null, AdminPluginScanFinding[]>()
  for (const f of findings) {
    const key = f.path || null
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }
  return Array.from(groups, ([path, items]) => ({ path, findings: items }))
}

/**
 * POST `multipart/form-data` with the single `package` field (the `.zip`) the
 * upload/validate endpoints accept (plugin-package-spec section 6). The legacy
 * `manifest` + `file` form is still accepted server-side during the transition but
 * the UI no longer sends it. Returns the parsed envelope; on a network failure or a
 * non-JSON body (nginx error page) it degrades to `{ success: false }` like clientApi.
 */
export async function postPluginPackage<T>(
  path: string,
  pkg: File,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const requestUrl = resolveApiUrl(path)

  const form = new FormData()
  form.append('package', pkg, pkg.name)

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
