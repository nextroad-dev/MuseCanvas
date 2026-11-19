// 仅限 React Server Components。导出前请注意：本模块从 `next/headers` 读取
// `muse_session` HttpOnly Cookie 并透传给后端，浏览器端禁止导入（会打包失败）。
//
// 服务端直连 API 的 base URL 优先 `INTERNAL_API_BASE_URL`（容器内 http://api:3001），
// 其次 `API_ORIGIN`（本地 dev），最后 localhost:3001；浏览器侧则走同源 /api 代理。

import { cookies } from 'next/headers'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  PublicModelDto,
  SetupStatusResponse,
} from '@musecanvas/contracts'
import { ApiError } from './api'
import type {
  AccountDto,
  AdminDashboardDto,
  AssetListDto,
  GenerationJobDto,
  GenerationJobListDto,
  OAuthIdentityDto,
  OAuthProviderInfo,
  RegistrationModeDto,
  SessionDto,
  SessionUserDto,
} from '@/shared/types'

const INTERNAL_API_ORIGIN = (
  process.env.INTERNAL_API_BASE_URL ||
  process.env.API_ORIGIN ||
  'http://localhost:3001'
).replace(/\/$/, '')

export interface ServerApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  params?: Record<string, string | number | boolean | undefined | null>
  headers?: Record<string, string>
  cache?: RequestCache
  next?: { revalidate?: false | 0 | number; tags?: string[] }
  signal?: AbortSignal
}

function serverUrl(path: string, params?: ServerApiOptions['params']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, INTERNAL_API_ORIGIN)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** 透传当前请求的会话 Cookie；RSC 预检与受保护读取的唯一凭据来源。 */
async function forwardedCookieHeader(): Promise<string | null> {
  const store = await cookies()
  const parts: string[] = []
  const session = store.get('muse_session')?.value
  if (session) parts.push(`muse_session=${session}`)
  // setup 向导的 HttpOnly 票据同样只在服务端可达，RSC 读取状态页时需要它。
  const setup = store.get('muse_setup')?.value
  if (setup) parts.push(`muse_setup=${setup}`)
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * RSC 端请求 + 信封解析，返回 `data`；失败抛 `ApiError`。
 * 网络失败映射为 `UPSTREAM_UNAVAILABLE`，让布局守卫能区分「未登录」与「后端宕机」。
 */
export async function serverApiFetch<T>(path: string, options: ServerApiOptions = {}): Promise<T> {
  const { method = 'GET', body, params, headers = {}, cache = 'no-store', next, signal } = options
  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
  const cookie = await forwardedCookieHeader()
  if (cookie) requestHeaders.Cookie = cookie
  let payload: BodyInit | undefined
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(serverUrl(path, params), {
      method,
      headers: requestHeaders,
      body: payload,
      cache,
      signal,
      ...(next ? { next } : {}),
    })
  } catch {
    throw new ApiError(0, 'UPSTREAM_UNAVAILABLE', '无法连接后端服务，请稍后重试')
  }

  const text = await response.text().catch(() => '')
  if (text.trim() === '') {
    if (response.ok) return undefined as T
    throw new ApiError(response.status, `HTTP_${response.status}`, `上游服务响应异常 (${response.status})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(
      response.status,
      response.status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM_UNAVAILABLE',
      `上游服务响应异常 (${response.status})`,
    )
  }
  const envelope = parsed as {
    success?: boolean
    data?: T
    error?: { code?: string; message?: string }
  }
  if (envelope.success === true) return envelope.data as T
  throw new ApiError(
    response.status,
    envelope.error?.code || `HTTP_${response.status}`,
    envelope.error?.message || '请求失败',
  )
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHORIZED')

/** 当前会话；未登录返回 `null`（布局守卫用它决定跳转）。 */
export async function getSession(): Promise<SessionDto | null> {
  try {
    return await serverApiFetch<SessionDto>(API_ENDPOINTS.session)
  } catch (error) {
    if (isUnauthorized(error)) return null
    throw error
  }
}

export async function getSessionUser(): Promise<SessionUserDto | null> {
  return (await getSession())?.user ?? null
}

/** 账户页 RSC 数据：会话 + 已绑定第三方身份。 */
export async function getAccount(): Promise<AccountDto | null> {
  const session = await getSession()
  if (!session) return null
  const oauthIdentities = await serverApiFetch<OAuthIdentityDto[]>(API_ENDPOINTS.account.oauth).catch(
    (error: unknown) => {
      if (isUnauthorized(error)) return [] as OAuthIdentityDto[]
      throw error
    },
  )
  return { user: session.user, oauthIdentities }
}

export async function getModels(): Promise<PublicModelDto[]> {
  return serverApiFetch<PublicModelDto[]>(API_ENDPOINTS.models)
}

export async function getLibrary(params?: {
  limit?: number
  cursor?: string
  q?: string
  kind?: 'image' | 'video'
  eligible?: boolean
}): Promise<AssetListDto> {
  return serverApiFetch<AssetListDto>(API_ENDPOINTS.library.list, { params })
}

export async function getJobs(): Promise<GenerationJobListDto> {
  return serverApiFetch<GenerationJobListDto>(API_ENDPOINTS.jobs.list)
}

export async function getJob(id: string): Promise<GenerationJobDto | null> {
  try {
    return await serverApiFetch<GenerationJobDto>(API_ENDPOINTS.jobs.detail(id))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function getAdminDashboard(): Promise<AdminDashboardDto> {
  return serverApiFetch<AdminDashboardDto>(API_ENDPOINTS.admin.dashboard)
}

export async function getRegistrationMode(): Promise<RegistrationModeDto> {
  return serverApiFetch<RegistrationModeDto>(API_ENDPOINTS.registration)
}

export async function getOAuthProviders(): Promise<OAuthProviderInfo[]> {
  const result = await serverApiFetch<{ providers: OAuthProviderInfo[] }>(
    API_ENDPOINTS.auth.oauthProviders,
  )
  return result.providers
}

/** 安装向导状态；公开端点，未完成时会附带 bootstrap 诊断。 */
export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return serverApiFetch<SetupStatusResponse>(API_ENDPOINTS.setup.status)
}

export { ApiError }
