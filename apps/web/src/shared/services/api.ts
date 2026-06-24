import type { ApiResponse } from '@/shared/types'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

interface RequestOptions {
  method?: string
  body?: unknown
  params?: Record<string, string>
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }
  return url.pathname + url.search
}

export async function api<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, params } = options
  const url = buildUrl(path, params)

  try {
    const requestUrl = BASE_URL.endsWith('/api') && url.startsWith('/api/')
      ? BASE_URL + url.slice(4)
      : BASE_URL + url
    const res = await fetch(requestUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    })

    const json = (await res.json()) as ApiResponse<T>
    return json
  } catch {
    return { success: false, error: { code: 'NETWORK_ERROR', message: '网络连接失败' } }
  }
}
