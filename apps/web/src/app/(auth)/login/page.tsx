import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { LoginForm } from '@/features/auth/components/login-form'
import { APP_ROUTES, safeRedirectPath } from '@/shared/lib/app-routes'
import {
  getOAuthProviders,
  getRegistrationMode,
  getSessionUser,
} from '@/shared/services/server-api'
import type { OAuthProviderInfo } from '@/shared/types'

/**
 * 登录页：RSC 会话预检 + Client Island 表单。
 *
 * 读取 `muse_session` Cookie 决定了本页必须动态渲染，不能 `force-static`；
 * 已登录用户在服务端直接重定向至目标页（支持 `?next=` 与旧链路 `?from=`，均经白名单收敛），
 * 避免客户端先闪一次表单。后端不可用时仍渲染表单并展示降级提示。
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '登录',
  description: '登录 MuseCanvas AI 创作工作台',
}

type LoginSearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** 目标页白名单之外再排除 `/login` 自身，避免 `?next=/login` 造成登录后回环。 */
function loginDestination(value: string | null): string {
  const path = safeRedirectPath(value)
  if (
    path === APP_ROUTES.login ||
    path.startsWith(`${APP_ROUTES.login}/`) ||
    path.startsWith(`${APP_ROUTES.login}?`)
  ) {
    return APP_ROUTES.generate
  }
  return path
}

export default async function LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
  const params = await searchParams
  const nextPath = loginDestination(firstValue(params.next) ?? firstValue(params.from))

  let sessionUser = null
  let backendUnavailable = false
  try {
    sessionUser = await getSessionUser()
  } catch {
    backendUnavailable = true
  }

  if (sessionUser) redirect(nextPath)

  // 公开配置端点并行预取；后端不可用或失败时平滑降级，不影响表单渲染。
  let requiresInvitation = false
  let initialProviders: OAuthProviderInfo[] | undefined

  if (!backendUnavailable) {
    const [registration, providers] = await Promise.all([
      getRegistrationMode().catch(() => null),
      getOAuthProviders().catch(() => null),
    ])
    requiresInvitation = registration?.requiresInvitation ?? false
    if (providers) initialProviders = providers
  }

  return (
    <LoginForm
      nextPath={nextPath}
      backendUnavailable={backendUnavailable}
      oauthError={firstValue(params.error)}
      oauthChallenge={firstValue(params.oauth_challenge) ?? firstValue(params.challenge)}
      oauthEmail={firstValue(params.email)}
      oauthProvider={firstValue(params.provider)}
      requiresInvitation={requiresInvitation}
      initialProviders={initialProviders}
    />
  )
}
