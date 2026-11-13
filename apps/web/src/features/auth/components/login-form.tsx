'use client'

// 登录页的客户端岛：邮箱 → 6 位验证码两步状态机 + 第三方整页跳转。
// 服务端预检（已登录 307）在 `app/(auth)/login/page.tsx`；这里只做交互与提交。
// 易失 UI 态（step / email / 是否需要邀请码）放 Zustand，服务端状态走 TanStack Query。

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FormEvent, KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react'
import { clientApi } from '@/shared/services/client-api'
import { useAuth, useOAuthProviders, oauthLoginUrl } from '@/shared/hooks/useAuth'
import { queryKeys } from '@/shared/hooks/query-keys'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import {
  Alert,
  Button,
  Divider,
  Field,
  Input,
  Skeleton,
  buttonVariants,
  iconSize,
} from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import type { OAuthProvider } from '@/shared/types'
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

/** 第三方按钮的展示顺序与图标；label 后端会返回，缺失时用这里的兜底。 */
const OAUTH_PROVIDERS: Record<OAuthProvider, { label: string; Icon: typeof GithubIcon }> = {
  github: { label: 'GitHub', Icon: GithubIcon },
  google: { label: 'Google', Icon: GoogleIcon },
}

export interface LoginFormProps {
  /** 登录成功后的白名单内部路径（RSC 已用 `safeRedirectPath` 归一化）。 */
  nextPath: string
  /** RSC 预检发现后端不可用：仍渲染表单，但先说明「提交可能失败」。 */
  backendUnavailable?: boolean
  /** OAuth 回调失败码（`?error=`）。 */
  oauthError?: string | null
  /** 邀请制 OAuth 新用户：先补邀请码再完成注册。 */
  oauthChallenge?: string | null
  oauthEmail?: string | null
  oauthProvider?: string | null
  /** `GET /registration` 的注册模式；true 时邮箱步直接展示邀请码输入。 */
  requiresInvitation?: boolean
}

type FieldKey = 'email' | 'invitation'
type FieldErrors = Partial<Record<FieldKey, string>>

/**
 * 登录表单。步骤：
 * 1. `email`：邮箱（邀请制时同时出现邀请码）→ `POST /auth/otp/request`；
 * 2. `code`：6 位验证码 → `POST /auth/otp/verify`，成功后写会话并跳转；
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

  // 两种邀请语义分开：
  // · `invitationRequired` = 后端已明确「这个邮箱未注册且站点邀请制」，提交时必须填；
  // · `requiresInvitation`（RSC 读 GET /registration）= 站点邀请制，首次登录需要邀请码，
  //   但已有账号可以直接登录，所以只显示输入框、不强制（后端 nextStep 会兜底）。
  const invitationRequired = storedRequiresInvitation
  const invitationVisible = invitationRequired || requiresInvitation
  const oauthChallengeActive = Boolean(oauthChallenge)
  const oauthCallbackError = describeOAuthError(oauthError)
  const enabledProviders = (providersQuery.data ?? []).filter((provider) => provider.enabled)

  // 验证码步缺少邮箱（例如刷新后 store 仍有旧 step）时退回第一步。
  useEffect(() => {
    if (step === 'code' && !email) setStep('email')
  }, [step, email, setStep])

  // 邮箱步把焦点交给邮箱输入框（从验证码步返回时也回到这里）；验证码步由 OtpInput 自己聚焦。
  useEffect(() => {
    if (oauthChallengeActive || step !== 'email') return
    emailInputRef.current?.focus()
  }, [step, oauthChallengeActive])

  // 进入验证码步开始前端冷却倒计时（纯样式，到零即允许重发）。
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
        // 后端判定该邮箱首次注册且站点为邀请制：补齐邀请码后再发一次。
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
      await verifyOtp(normalizeEmail(email), normalized)
      // verify 已把 session 写入缓存；再失效一次，让其它页面拿到服务端权威态。
      // 成功后直接离开：不在这里 resetAuthUi，避免导航完成前闪回邮箱表单；
      // 退出登录时账户页会重置登录 UI 态。
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
      router.replace(nextPath)
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
      const session = await clientApi.auth.completeOAuthInvitation(oauthChallenge, invitationCode.trim())
      queryClient.setQueryData(queryKeys.session, session)
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
      router.replace(nextPath)
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
    <div className="flex flex-col gap-7">
      {oauthChallengeActive ? (
        <section aria-label="完成邀请码注册" className="flex flex-col gap-7">
          <header className="flex flex-col gap-2">
            <h1 className="text-title text-foreground">完成邀请码注册</h1>
            <p className="text-compact text-muted-foreground [text-wrap:pretty]">
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
                className="px-3.5 text-compact"
                disabled={oauthSubmitting}
                placeholder="请填写邀请码"
              />
            </Field>
            <Button type="submit" size="lg" fullWidth loading={oauthSubmitting} className="text-compact">
              完成注册并登录
            </Button>
          </form>

          <Button
            variant="ghost"
            size="sm"
            className="-ml-1 self-center px-2 text-compact"
            onClick={() => {
              resetAuthUi()
              router.replace(APP_ROUTES.login)
            }}
          >
            返回登录
          </Button>
        </section>
      ) : step === 'code' ? (
        <section aria-label="输入验证码" className="flex flex-col gap-7">
          <header className="flex flex-col gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft weight="bold" aria-hidden="true" />}
              onClick={backToEmail}
              disabled={submitting}
              className="-ml-1 self-start px-2 text-compact text-muted-foreground"
            >
              修改邮箱
            </Button>
            <h1 className="text-title text-foreground">输入验证码</h1>
            <p className="text-compact text-muted-foreground [overflow-wrap:anywhere]">
              6 位验证码已发送到 <span className="font-medium text-foreground">{email}</span>
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
            className="flex flex-col gap-4"
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

            <Button type="submit" size="lg" fullWidth loading={submitting} className="text-compact">
              验证并登录
            </Button>

            <div className="flex items-center justify-between gap-3 text-ui">
              <span className="text-muted-foreground">没收到？检查垃圾邮件</span>
              <button
                type="button"
                onClick={() => void handleResend()}
                disabled={submitting || resendIn > 0}
                className="inline-flex min-h-[var(--control-sm)] items-center rounded-control px-2 font-mono tabular-nums text-foreground transition-colors disabled:text-muted-foreground not-disabled:hover:bg-tonal"
              >
                {resendIn > 0 ? `重新发送 · ${formatCountdown(resendIn)}` : '重新发送'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section aria-label="邮箱登录" className="flex flex-col gap-7">
          <header className="flex flex-col gap-2">
            <h1 className="text-title text-foreground">登录 MuseCanvas</h1>
            <p className="text-compact text-muted-foreground">开始你的创意</p>
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
              hint="邮箱只用于登录与作品找回。"
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
                className="px-3.5 text-compact"
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
                  className="px-3.5 text-compact"
                  disabled={submitting}
                  placeholder="请填写邀请码"
                />
              </Field>
            ) : null}

            <Button type="submit" size="lg" fullWidth loading={submitting} className="text-compact">
              {invitationRequired ? '确认并发送验证码' : '发送验证码'}
            </Button>
          </form>

          {enabledProviders.length > 0 ? (
            <section aria-label="第三方账号登录" className="flex flex-col gap-4">
              <Divider label="或使用第三方账号" labelClassName="bg-canvas" />
              <div className="grid grid-cols-2 gap-2.5">
                {enabledProviders.map((provider) => {
                  const meta = OAUTH_PROVIDERS[provider.provider]
                  if (!meta) return null
                  const Icon = meta.Icon
                  return (
                    <a
                      key={provider.provider}
                      href={oauthLoginUrl(provider.provider)}
                      className={cn(
                        buttonVariants({ variant: 'secondary' }),
                        'min-h-[var(--control-touch)] gap-2.5 text-compact',
                      )}
                    >
                      <Icon className={cn('shrink-0', iconSize.md)} />
                      <span>{provider.label || meta.label}</span>
                    </a>
                  )
                })}
              </div>
            </section>
          ) : providersQuery.isPending ? (
            <div className="flex flex-col gap-4" aria-busy="true">
              <span className="sr-only">正在读取可用的第三方登录方式</span>
              <Skeleton className="h-px w-full rounded-none" />
              <div className="grid grid-cols-2 gap-2.5" aria-hidden="true">
                <Skeleton className="h-[var(--control-touch)] rounded-control" />
                <Skeleton className="h-[var(--control-touch)] rounded-control" />
              </div>
            </div>
          ) : null}
        </section>
      )}

      <p className="text-center text-xs text-muted-foreground [text-wrap:pretty]">
        登录即代表你已阅读并同意{' '}
        <Link href={APP_ROUTES.terms} className="rounded-control text-foreground">
          用户协议
        </Link>{' '}
        与{' '}
        <Link href={APP_ROUTES.privacy} className="rounded-control text-foreground">
          隐私政策
        </Link>
        。
      </p>
    </div>
  )
}
