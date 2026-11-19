'use client'

// 登录页客户端岛：邮箱 → 6 位验证码两步状态机 + 邀请码校验 + 第三方 OAuth 跳转。
// 服务端预检（已登录重定向）在 `app/(auth)/login/page.tsx`；这里只处理交互与提交。
// 易失 UI 态（step / email / requiresInvitation）托管于 Zustand，服务端会话走 TanStack Query。

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FormEvent, KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  EnvelopeSimpleIcon,
  KeyIcon,
  SparkleIcon,
} from '@phosphor-icons/react'

import { clientApi } from '@/shared/services/client-api'
import { useAuth, useOAuthProviders, oauthLoginUrl } from '@/shared/hooks/useAuth'
import { queryKeys } from '@/shared/hooks/query-keys'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import { APP_ROUTES, safeRedirectPath } from '@/shared/lib/app-routes'
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Input,
  Skeleton,
  controlSquare,
  iconSize,
} from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import type { OAuthProvider, OAuthProviderInfo } from '@/shared/types'
import { OtpInput } from './otp-input'
import { GithubIcon, GoogleIcon } from './brand-icons'
import {
  describeAuthError,
  describeOAuthError,
  formatCountdown,
  normalizeEmail,
  validateEmail,
} from '../lib/auth-errors'
import { OTP_LENGTH, sanitizeOtpChunk } from '../lib/otp'

/** 前端冷却纯样式：服务端只有限流（10 分钟窗口），没有可查询的冷却状态。 */
const RESEND_COOLDOWN_SECONDS = 60

/** 第三方按钮的展示顺序与图标；label 由后端返回，缺失时使用兜底文案。 */
const OAUTH_PROVIDERS: Record<OAuthProvider, { label: string; Icon: typeof GithubIcon }> = {
  github: { label: 'GitHub', Icon: GithubIcon },
  google: { label: 'Google', Icon: GoogleIcon },
}

export interface LoginFormProps {
  /** 登录成功后的白名单内部路径（RSC 已通过 `safeRedirectPath` 收敛）。 */
  nextPath: string
  /** RSC 预检发现后端不可用：仍渲染表单，先给出可预期提示。 */
  backendUnavailable?: boolean
  /** OAuth 回调失败码（`?error=`）。 */
  oauthError?: string | null
  /** 邀请制 OAuth 新用户：先补邀请码再完成注册（`?oauth_challenge=` / `?challenge=`）。 */
  oauthChallenge?: string | null
  oauthEmail?: string | null
  oauthProvider?: string | null
  /** `GET /registration` 的注册模式；true 时邮箱步直接展示邀请码输入。 */
  requiresInvitation?: boolean
  /** RSC 预取的 OAuth 供应商列表；传入后首屏即呈现，避免骨架闪烁。 */
  initialProviders?: OAuthProviderInfo[]
}

type FieldKey = 'email' | 'invitation'
type FieldErrors = Partial<Record<FieldKey, string>>

/**
 * 登录表单卡片。步骤：
 * 1. `email`：邮箱（邀请制时同时出现邀请码）→ `POST /auth/otp/request`；
 * 2. `code`：6 位验证码 → `POST /auth/otp/verify`，成功后写入会话并跳转；
 * 3. `oauth-invitation`：第三方回调要求邀请码时 → `POST /auth/oauth/invitation`。
 */
export function LoginForm({
  nextPath,
  backendUnavailable = false,
  oauthError,
  oauthChallenge,
  oauthEmail,
  oauthProvider,
  requiresInvitation = false,
  initialProviders,
}: LoginFormProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { requestOtp, verifyOtp } = useAuth()
  const providersQuery = useOAuthProviders()

  const step = useAuthUiStore((state) => state.step)
  const email = useAuthUiStore((state) => state.email)
  const setStep = useAuthUiStore((state) => state.setStep)
  const setEmail = useAuthUiStore((state) => state.setEmail)
  const storedRequiresInvitation = useAuthUiStore((state) => state.requiresInvitation)
  const setRequiresInvitation = useAuthUiStore((state) => state.setRequiresInvitation)
  const resetAuthUi = useAuthUiStore((state) => state.reset)

  const [code, setCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [oauthSubmitting, setOauthSubmitting] = useState(false)
  const [resendIn, setResendIn] = useState(0)

  const emailInputRef = useRef<HTMLInputElement | null>(null)
  const invitationInputRef = useRef<HTMLInputElement | null>(null)
  const otpFirstRef = useRef<HTMLInputElement | null>(null)
  const inFlightRef = useRef(false)

  const destination = safeRedirectPath(nextPath)

  // 两种邀请语义分开：
  // · `invitationRequired` = 后端明确该邮箱未注册且站点为邀请制，提交时必填；
  // · `requiresInvitation`（RSC 读 GET /registration）= 站点邀请制，首次登录需要邀请码，
  //   已有账号可直接登录，因此先展示输入框但不强制（由后端 nextStep 兜底）。
  const invitationRequired = storedRequiresInvitation
  const invitationVisible = invitationRequired || requiresInvitation
  const oauthChallengeActive = Boolean(oauthChallenge)
  const oauthCallbackError = describeOAuthError(oauthError)

  const providers = providersQuery.data ?? initialProviders ?? []
  const enabledProviders = providers.filter((provider) => provider.enabled)
  const providersLoading = initialProviders === undefined && providersQuery.isPending

  // 验证码步缺少邮箱（例如刷新后 store 残留旧 step）时退回邮箱步。
  useEffect(() => {
    if (step === 'code' && !email) setStep('email')
  }, [step, email, setStep])

  // 邮箱步聚焦邮箱输入框；验证码步由 OtpInput 自身处理聚焦。
  useEffect(() => {
    if (oauthChallengeActive || step !== 'email') return
    emailInputRef.current?.focus()
  }, [step, oauthChallengeActive])

  // 进入验证码步启动冷却倒计时。
  useEffect(() => {
    if (step !== 'code' || resendIn <= 0) return
    const timer = window.setTimeout(() => setResendIn((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [step, resendIn])

  const beginRequest = useCallback(() => {
    if (inFlightRef.current) return false
    inFlightRef.current = true
    setSubmitting(true)
    return true
  }, [])

  const endRequest = useCallback(() => {
    inFlightRef.current = false
    setSubmitting(false)
  }, [])

  function clearFieldError(key: FieldKey) {
    setFieldErrors((previous) => {
      if (!previous[key]) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  function focusFirstError(next: FieldErrors) {
    if (next.email) emailInputRef.current?.focus()
    else if (next.invitation) invitationInputRef.current?.focus()
  }

  function enterCodeStep() {
    setStep('code')
    // 请求已被接受，说明邀请码不再缺失（首次注册会在 verify 时消费邀请码）。
    setRequiresInvitation(false)
    setFormError(null)
    setResendIn(RESEND_COOLDOWN_SECONDS)
  }

  function backToEmail() {
    setStep('email')
    setFormError(null)
    setFieldErrors({})
  }

  /** Esc 取消：验证码步回退到修改邮箱；其余步骤不拦截。 */
  function handleFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Escape') return
    if (step === 'code') backToEmail()
  }

  async function sendOtp() {
    const trimmedEmail = normalizeEmail(email)
    const emailError = validateEmail(email)
    const invitationMissing = invitationRequired && !invitationCode.trim()
    const next: FieldErrors = {}
    if (emailError) next.email = emailError
    if (invitationMissing) next.invitation = '请填写邀请码后再发送验证码。'
    setFieldErrors(next)
    if (next.email || next.invitation) {
      focusFirstError(next)
      return
    }

    setFormError(null)
    if (!beginRequest()) return
    try {
      const result = await requestOtp(trimmedEmail, invitationCode.trim() || undefined)
      setEmail(trimmedEmail)
      if (result.accepted) {
        enterCodeStep()
      } else if (result.nextStep === 'invitation') {
        setRequiresInvitation(true)
        setFormError('该邮箱尚未注册，本站为邀请制。请填写邀请码后继续；已有账号可留空。')
        invitationInputRef.current?.focus()
      } else {
        enterCodeStep()
      }
    } catch (error) {
      setFormError(describeAuthError(error, '验证码发送失败，请稍后重试。'))
    } finally {
      endRequest()
    }
  }

  async function handleSendOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await sendOtp()
  }

  async function verifyCode(value: string) {
    const normalized = sanitizeOtpChunk(value, OTP_LENGTH)
    if (normalized.length < OTP_LENGTH) {
      setFormError('请输入完整的 6 位验证码。')
      otpFirstRef.current?.focus()
      return
    }

    setFormError(null)
    if (!beginRequest()) return
    try {
      const { setupRequired } = await verifyOtp(normalizeEmail(email), normalized)
      // verify 已写入 session 缓存；失效一次确保其它页面同步服务端权威态。
      // 成功后直接离开：不在导航前 resetAuthUi，避免离开前闪回邮箱步。
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
      router.replace(setupRequired ? APP_ROUTES.setup : destination)
      router.refresh()
    } catch (error) {
      setFormError(describeAuthError(error, '验证码校验失败，请确认后重试。'))
      otpFirstRef.current?.focus()
    } finally {
      endRequest()
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await verifyCode(code)
  }

  async function handleResend() {
    if (resendIn > 0 || inFlightRef.current) return
    setFormError(null)
    if (!beginRequest()) return
    try {
      const result = await requestOtp(normalizeEmail(email), invitationCode.trim() || undefined)
      if (result.accepted) {
        setResendIn(RESEND_COOLDOWN_SECONDS)
        setCode('')
        otpFirstRef.current?.focus()
      } else if (result.nextStep === 'invitation') {
        setRequiresInvitation(true)
        setStep('email')
        setFormError('该邮箱尚未注册，本站为邀请制。请填写邀请码后继续。')
      } else {
        setResendIn(RESEND_COOLDOWN_SECONDS)
      }
    } catch (error) {
      setFormError(describeAuthError(error, '验证码重新发送失败，请稍后重试。'))
    } finally {
      endRequest()
    }
  }

  async function handleOAuthInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauthChallenge) return
    if (!invitationCode.trim()) {
      setFieldErrors({ invitation: '请填写邀请码后完成注册。' })
      invitationInputRef.current?.focus()
      return
    }

    setFormError(null)
    if (oauthSubmitting) return
    setOauthSubmitting(true)
    try {
      const { user, setupRequired } = await clientApi.auth.completeOAuthInvitation(
        oauthChallenge,
        invitationCode.trim(),
      )
      queryClient.setQueryData(queryKeys.session, { user })
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
      router.replace(setupRequired ? APP_ROUTES.setup : destination)
      router.refresh()
    } catch (error) {
      setFormError(describeAuthError(error, '邀请码注册未完成，请稍后重试。'))
    } finally {
      setOauthSubmitting(false)
    }
  }

  const oauthProviderLabel = oauthProvider
    ? (OAUTH_PROVIDERS[oauthProvider as OAuthProvider]?.label ?? oauthProvider)
    : '第三方'

  return (
    <Card density="none" className="w-full gap-6 p-6 sm:p-8">
      {oauthChallengeActive ? (
        <section key="oauth-invitation" aria-label="完成邀请码注册" className="motion-reveal flex flex-col gap-6">
          <header className="flex flex-col gap-2.5">
            <div
              className={cn(
                'inline-flex items-center justify-center rounded-card border border-border bg-accent-soft text-accent',
                controlSquare.lg,
              )}
            >
              <KeyIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
            </div>
            <h1 className="text-title text-foreground">完成邀请码注册</h1>
            <p className="text-sm text-muted-foreground">
              {oauthProviderLabel} 账号
              {oauthEmail ? (
                <>
                  {' '}
                  <span className="break-all font-medium text-foreground">{oauthEmail}</span>{' '}
                </>
              ) : null}
              尚未注册 MuseCanvas。本站为邀请制，请填写邀请码完成注册。
            </p>
          </header>

          {formError ? (
            <Alert tone="danger" role="alert" title="无法完成注册">
              {formError}
            </Alert>
          ) : null}

          <form noValidate onSubmit={handleOAuthInvitation} className="flex flex-col gap-4">
            <Field
              id="oauth-invitation"
              label="邀请码"
              required
              error={fieldErrors.invitation}
              hint="邀请码由站点管理员提供，通常只能使用一次。"
            >
              <Input
                ref={invitationInputRef}
                value={invitationCode}
                onChange={(event) => {
                  setInvitationCode(event.target.value)
                  clearFieldError('invitation')
                }}
                autoComplete="off"
                size="lg"
                disabled={oauthSubmitting}
                placeholder="请填写邀请码"
              />
            </Field>
            <Button type="submit" size="lg" fullWidth loading={oauthSubmitting}>
              完成注册并登录
            </Button>
          </form>

          <Button
            variant="ghost"
            size="sm"
            className="self-center text-muted-foreground"
            onClick={() => {
              resetAuthUi()
              router.replace(APP_ROUTES.login)
            }}
          >
            返回登录
          </Button>
        </section>
      ) : step === 'code' ? (
        <section key="code" aria-label="输入验证码" className="motion-reveal flex flex-col gap-6">
          <header className="flex flex-col gap-2.5">
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<ArrowLeftIcon weight="bold" aria-hidden="true" />}
              onClick={backToEmail}
              disabled={submitting}
              className="-ml-2.5 self-start text-muted-foreground"
            >
              修改邮箱
            </Button>
            <div
              className={cn(
                'inline-flex items-center justify-center rounded-card border border-border bg-accent-soft text-accent',
                controlSquare.lg,
              )}
            >
              <EnvelopeSimpleIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
            </div>
            <h1 className="text-title text-foreground">输入验证码</h1>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              6 位验证码已发送到{' '}
              <span className="inline-flex items-center rounded-pill border border-border bg-tonal px-2 py-0.5 font-medium text-foreground">
                {email}
              </span>
            </p>
          </header>

          {formError ? (
            <Alert tone="danger" role="alert" title="登录未完成">
              {formError}
            </Alert>
          ) : null}

          <form
            noValidate
            onSubmit={handleVerifyOtp}
            onKeyDown={handleFormKeyDown}
            className="flex flex-col gap-5"
          >
            <OtpInput
              id="login-otp"
              value={code}
              onChange={(next) => {
                setCode(next)
                if (formError) setFormError(null)
              }}
              onComplete={(value) => {
                void verifyCode(value)
              }}
              onEscape={backToEmail}
              disabled={submitting}
              autoFocus
              length={OTP_LENGTH}
              invalid={Boolean(formError)}
              describedBy={formError ? undefined : 'login-otp-hint'}
              firstInputRef={otpFirstRef}
            />

            {formError ? null : (
              <p id="login-otp-hint" className="text-ui text-muted-foreground">
                支持直接粘贴整串验证码，输满 6 位自动提交。
              </p>
            )}

            <Button type="submit" size="lg" fullWidth loading={submitting}>
              验证并登录
            </Button>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4 text-ui">
              <span className="text-muted-foreground">没收到？请检查垃圾邮件</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleResend()}
                disabled={submitting || resendIn > 0}
                className="font-mono tabular-nums"
              >
                {resendIn > 0 ? `重新发送 · ${formatCountdown(resendIn)}` : '重新发送'}
              </Button>
            </div>
          </form>
        </section>
      ) : (
        <section key="email" aria-label="邮箱登录" className="motion-reveal flex flex-col gap-6">
          <header className="flex flex-col gap-2.5">
            <Badge
              tone="accent"
              icon={<SparkleIcon weight="fill" aria-hidden="true" />}
              className="self-start"
            >
              AI Studio 创作入口
            </Badge>
            <h1 className="text-title text-foreground">登录 MuseCanvas</h1>
            <p className="text-sm text-muted-foreground">输入邮箱验证码或使用第三方账号开始创作</p>
          </header>

          {backendUnavailable ? (
            <Alert tone="warning" title="服务暂时不可用">
              无法连接登录服务，提交可能会失败。请检查网络后重试。
            </Alert>
          ) : null}

          {oauthCallbackError ? (
            <Alert tone="warning" title="第三方登录未完成">
              {oauthCallbackError}
            </Alert>
          ) : null}

          {formError ? (
            <Alert tone="danger" role="alert" title="无法发送验证码">
              {formError}
            </Alert>
          ) : null}

          <form noValidate onSubmit={handleSendOtp} className="flex flex-col gap-4">
            <Field
              id="login-email"
              label="邮箱地址"
              required
              error={fieldErrors.email}
              hint="邮箱仅用于登录与作品找回。"
            >
              <Input
                ref={emailInputRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                size="lg"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  clearFieldError('email')
                  if (formError) setFormError(null)
                }}
                placeholder="name@example.com"
                disabled={submitting}
              />
            </Field>

            {invitationVisible ? (
              <Field
                id="login-invitation"
                label="邀请码"
                required={invitationRequired}
                error={fieldErrors.invitation}
                hint={
                  invitationRequired
                    ? '该邮箱尚未注册，请填写管理员提供的邀请码。'
                    : '本站为邀请制：首次登录需要邀请码，已有账号可留空。'
                }
              >
                <Input
                  ref={invitationInputRef}
                  value={invitationCode}
                  onChange={(event) => {
                    setInvitationCode(event.target.value)
                    clearFieldError('invitation')
                    if (formError) setFormError(null)
                  }}
                  autoComplete="off"
                  size="lg"
                  disabled={submitting}
                  placeholder="请填写邀请码"
                />
              </Field>
            ) : null}

            <Button type="submit" size="lg" fullWidth loading={submitting}>
              {invitationRequired ? '确认并发送验证码' : '发送验证码'}
            </Button>
          </form>

          {enabledProviders.length > 0 ? (
            <section aria-label="第三方账号登录" className="flex flex-col gap-4">
              <Divider label="或使用第三方账号" labelClassName="bg-surface" />
              <div
                className={cn(
                  'grid gap-2.5',
                  enabledProviders.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                )}
              >
                {enabledProviders.map((provider) => {
                  const meta = OAUTH_PROVIDERS[provider.provider]
                  if (!meta) return null
                  const Icon = meta.Icon
                  return (
                    <Button key={provider.provider} variant="outline" size="lg" asChild>
                      <a href={oauthLoginUrl(provider.provider)}>
                        <Icon className={cn('shrink-0', iconSize.md)} />
                        <span>{provider.label || meta.label}</span>
                      </a>
                    </Button>
                  )
                })}
              </div>
            </section>
          ) : providersLoading ? (
            <div className="flex flex-col gap-4" aria-busy="true">
              <span className="sr-only">正在读取可用的第三方登录方式</span>
              <Skeleton className="h-px w-full rounded-none" />
              <div className="grid grid-cols-2 gap-2.5" aria-hidden="true">
                <Skeleton className="h-[var(--control-lg)] rounded-control" />
                <Skeleton className="h-[var(--control-lg)] rounded-control" />
              </div>
            </div>
          ) : null}
        </section>
      )}

      <p className="border-t border-border pt-4 text-center text-xs text-muted-foreground">
        登录即代表你已阅读并同意{' '}
        <Link
          href={APP_ROUTES.terms}
          className="rounded-control text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        >
          用户协议
        </Link>{' '}
        与{' '}
        <Link
          href={APP_ROUTES.privacy}
          className="rounded-control text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        >
          隐私政策
        </Link>
        。
      </p>
    </Card>
  )
}
