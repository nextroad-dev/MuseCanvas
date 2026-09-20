import type { ApiResponse } from '@/shared/types'

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

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

    const json = (await res.json()) as ApiResponse<T>
    return json
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: { code: 'ABORTED', message: '请求已取消' } }
    }
    return { success: false, error: { code: 'NETWORK_ERROR', message: '网络连接失败' } }
  }
}

export const api = clientApi
