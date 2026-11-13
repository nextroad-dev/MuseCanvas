import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { LoginForm } from '@/features/auth/components/login-form'
import { APP_ROUTES, safeRedirectPath } from '@/shared/lib/app-routes'
import { getRegistrationMode, getSession } from '@/shared/services/server-api'

/**
 * 登录页：RSC 会话预检 + Client Island 表单。
 *
 * 读 `muse_session` Cookie 决定了本页必须动态渲染，不能 `force-static`；
 * 已登录用户在服务端直接 307 到目标页（`?next=` 先经白名单归一化），
 * 避免客户端先闪一次表单。后端不可用时仍渲染表单，并把提示交给表单展示。
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
  if (path === APP_ROUTES.login || path.startsWith(`${APP_ROUTES.login}/`) || path.startsWith(`${APP_ROUTES.login}?`)) {
    return APP_ROUTES.generate
  }
  return path
}

export default async function LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
  const params = await searchParams
  // 兼容 `?next=` 与旧链路的 `?from=`；两者都收敛为站内白名单路径。
  const nextPath = loginDestination(firstValue(params.next) ?? firstValue(params.from))

  let session = null
  let backendUnavailable = false
  try {
    session = await getSession()
  } catch {
    backendUnavailable = true
  }

  if (session) redirect(nextPath)

  // 公开端点；后端不可用时按「非邀请制」降级，真正的邀请判断会由 otp/request 的 nextStep 兜住。
  const registration = backendUnavailable
    ? null
    : await getRegistrationMode().catch(() => null)

  return (
    <LoginForm
      nextPath={nextPath}
      backendUnavailable={backendUnavailable}
      oauthError={firstValue(params.error)}
      oauthChallenge={firstValue(params.oauth_challenge)}
      oauthEmail={firstValue(params.email)}
      oauthProvider={firstValue(params.provider)}
      requiresInvitation={registration?.requiresInvitation ?? false}
    />
  )
}
