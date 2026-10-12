// 严禁在 Client Component 中导入此模块（会打入服务端凭据逻辑）。
import { cookies } from 'next/headers'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { ApiResponse, Session } from '@/shared/types'

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

    // 错误码分层：后端 JSON 响应透传其 error.code（401→UNAUTHORIZED 等）；
    // 非 JSON / 网络失败 → UPSTREAM_UNAVAILABLE，SSR 门据此区分「未登录」与「后端宕机」。
    let payload: ApiResponse<T>
    try {
      payload = (await res.json()) as ApiResponse<T>
    } catch {
      return {
        success: false,
        error: { code: res.status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM_UNAVAILABLE', message: `上游服务响应异常 (${res.status})` },
      }
    }
    return payload
  } catch {
    return {
      success: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: '无法连接后端服务，请稍后重试' },
    }
  }
}

serverApi.get = <T>(path: string, options?: Omit<ServerRequestOptions, 'method'>) =>
  serverApi<T>(path, { ...options, method: 'GET' })

serverApi.post = <T>(path: string, body?: unknown, options?: Omit<ServerRequestOptions, 'method' | 'body'>) =>
  serverApi<T>(path, { ...options, method: 'POST', body })

serverApi.getMe = () => serverApi.get<Session>(API_ENDPOINTS.session)
