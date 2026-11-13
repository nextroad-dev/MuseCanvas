// 同源 HTTP 客户端底座：统一信封解析、错误模型、查询串与 204/空响应处理。
// 浏览器侧走 Next 同源 `/api` 反代（开发期 next.config 代理，生产期 nginx），
// 服务端 RSC 不走本模块（见 server-api.ts）。

import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { ParameterErrorDetails } from '@musecanvas/contracts'

/** 可选 API 基址：仅用于把 web 指向独立后端；默认空 = 同源 `/api`。 */
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

export type QueryValue = string | number | boolean | undefined | null

export type ApiRequestInit = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** JSON 请求体；FormData 请用 `body` 字段传，模块会自动改用 multipart。 */
  body?: unknown
  params?: Record<string, QueryValue>
  headers?: Record<string, string>
  signal?: AbortSignal
  cache?: RequestCache
  /** 默认 true：同源 Cookie（muse_session）随请求发送。 */
  credentials?: RequestCredentials
}

/**
 * 后端统一失败形状：`{ success: false, error: { code, message, details? } }`。
 * `status` 保留 HTTP 码，供 hook 区分 401（未登录）/ 409（冲突）等。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: ParameterErrorDetails

  constructor(status: number, code: string, message: string, details?: ParameterErrorDetails) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** 把查询参数拼成 `?a=1&b=2`；空值（undefined/null/空串）被省略。 */
export function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

/** 解析相对 `/api/...` 路径；配置了独立基址时替换其前缀。 */
export function resolveApiUrl(path: string, params?: Record<string, QueryValue>): string {
  const withQuery = `${path.startsWith('/') ? path : `/${path}`}${buildQuery(params)}`
  if (!API_BASE_URL) return withQuery
  if (API_BASE_URL.endsWith('/api') && withQuery.startsWith('/api/')) {
    return API_BASE_URL + withQuery.slice(4)
  }
  return API_BASE_URL + withQuery
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error?: { code?: string; message?: string; details?: ParameterErrorDetails } }

function parseEnvelope<T>(status: number, text: string): T {
  if (text.trim() === '') return undefined as T
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ApiError(status, `HTTP_${status}`, '上游服务响应异常')
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new ApiError(status, `HTTP_${status}`, '上游服务响应异常')
  }
  const envelope = payload as Envelope<T>
  if (envelope.success === true) return envelope.data
  const error = (envelope as { error?: { code?: string; message?: string; details?: ParameterErrorDetails } }).error
  throw new ApiError(
    status,
    error?.code || `HTTP_${status}`,
    error?.message || '请求失败',
    error?.details,
  )
}

/**
 * 发起一次同源 API 请求并拆信封，返回 `data`；失败抛 `ApiError`。
 *
 * - 204/空响应返回 `undefined`（类型上仍标 `T`，调用方仅在真有 data 的端点上使用）。
 * - `FormData` 请求体不设置 Content-Type（浏览器自行带 boundary）。
 * - 网络中断/中止分别映射为 `NETWORK_ERROR` / `ABORTED`，与后端错误码同域。
 */
export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { method = 'GET', body, params, headers = {}, signal, cache, credentials = 'include' } = init
  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
  let requestBody: BodyInit | undefined
  if (body instanceof FormData) {
    requestBody = body
  } else if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json'
    requestBody = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(resolveApiUrl(path, params), {
      method,
      headers: requestHeaders,
      body: requestBody,
      credentials,
      signal,
      ...(cache ? { cache } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'ABORTED', '请求已取消')
    }
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败')
  }

  const text = await response.text().catch(() => '')
  return parseEnvelope<T>(response.status, text)
}

export { API_ENDPOINTS }
