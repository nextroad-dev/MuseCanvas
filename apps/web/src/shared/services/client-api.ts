import type { ApiResponse } from '@/shared/types'

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  params?: Record<string, string | number | boolean | undefined | null>
  headers?: Record<string, string>
  signal?: AbortSignal
}

function buildUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  const url = new URL(path, origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v))
      }
    }
  }
  return url.pathname + url.search
}

export async function clientApi<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, params, headers = {}, signal } = options
  const relativeUrl = buildUrl(path, params)

  try {
    const requestUrl = BASE_URL.endsWith('/api') && relativeUrl.startsWith('/api/')
      ? BASE_URL + relativeUrl.slice(4)
      : BASE_URL + relativeUrl

    const res = await fetch(requestUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal,
    })

    // 后端契约以 body 的 success 字段为唯一判据（POST /api/generations 返回 202），
    // 这里只兜底非 JSON 响应（nginx 502 HTML、代理错误页等），避免误判为 NETWORK_ERROR。
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
