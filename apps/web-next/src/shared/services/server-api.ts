import { cookies } from 'next/headers'
import type { ApiResponse } from '@/shared/types'

const INTERNAL_API_ORIGIN =
  process.env.INTERNAL_API_BASE_URL ||
  process.env.API_ORIGIN ||
  'http://localhost:3001'

export interface ServerRequestOptions {
  method?: string
  body?: unknown
  params?: Record<string, string>
  headers?: Record<string, string>
  cache?: RequestCache
  next?: { revalidate?: false | 0 | number; tags?: string[] }
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(normalizedPath, INTERNAL_API_ORIGIN)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, v)
      }
    }
  }
  return url.toString()
}

export async function serverApi<T>(
  path: string,
  options: ServerRequestOptions = {},
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, params, headers = {}, cache = 'no-store', next } = options
  const requestUrl = buildUrl(path, params)

  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get('muse_session')?.value

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    }

    if (sessionToken) {
      requestHeaders['Cookie'] = `muse_session=${sessionToken}`
    }

    const res = await fetch(requestUrl, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache,
      next,
    })

    const json = (await res.json()) as ApiResponse<T>
    return json
  } catch (err: unknown) {
    return {
      success: false,
      error: { code: 'SERVER_API_ERROR', message: '服务端请求 API 失败' },
    }
  }
}

serverApi.get = <T>(path: string, options?: Omit<ServerRequestOptions, 'method'>) =>
  serverApi<T>(path, { ...options, method: 'GET' })

serverApi.post = <T>(path: string, body?: unknown, options?: Omit<ServerRequestOptions, 'method' | 'body'>) =>
  serverApi<T>(path, { ...options, method: 'POST', body })

serverApi.getMe = () => serverApi<any>('/api/auth/me')

