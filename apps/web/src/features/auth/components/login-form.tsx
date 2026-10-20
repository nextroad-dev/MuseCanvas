'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { createLoginRequestGate } from '../lib/login-request-state'
import { OtpInput } from './otp-input'
import type { FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { ArrowLeftIcon as ArrowLeft, WarningCircleIcon as CircleAlert } from '@phosphor-icons/react'
import { api, ApiError } from '@/shared/services/api'
import { cn } from '@/shared/lib/cn'
import { ACCOUNT_QUERY_KEY } from '@/shared/hooks/useAccount'
import type { User, OAuthProviderInfo } from '@/shared/types'
import { safeRedirectPath } from '@/shared/lib/app-routes'
import {
  Alert,
  Button,
  Divider,
  FieldGroup,
  FormField,
  IconButton,
  Input,
  buttonVariants,
  iconSize,
} from '@/shared/components/ui'
import { GithubIcon, GoogleIcon } from '@/shared/components/brand-icons'

type Step = 'email' | 'invitation' | 'otp'
/** Every step owns exactly one field, so a failed request has a home to report in. */
type FieldKey = 'email' | 'invitation' | 'otp'
type FieldErrors = Partial<Record<FieldKey, string>>

const fieldOfStep: Record<Step, FieldKey> = {
  email: 'email',
  invitation: 'invitation',
  otp: 'otp',
}

/** Shape check only — the backend stays the authority on whether an address exists. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** copy.md §4: 发生了什么 + 为什么 + 如何解决. */
const NETWORK_ERROR = '网络连接失败。设备可能未联网或后端服务暂时不可用，请检查网络后重试。'
const OTP_SEND_FAILED = '验证码发送失败。请确认邮箱地址填写无误，稍后重新发送。'

/** 纯样式倒计时：冷却结束前禁用重发，到零即恢复调用既有 otp/request（后端无冷却状态）。 */
const RESEND_COOLDOWN_SECONDS = 60

/** Both OAuth slots always render (disabled until enabled), so the row never jumps when providers load. */
const OAUTH_SLOTS = [
  { provider: 'github', label: 'GitHub', Icon: GithubIcon },
  { provider: 'google', label: 'Google', Icon: GoogleIcon },
] as const

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = safeRedirectPath(searchParams.get('from'))
  const oauthError = searchParams.get('error')

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [resendIn, setResendIn] = useState(0)
  const [requestGate] = useState(createLoginRequestGate)
  useEffect(() => () => requestGate.cancel(), [requestGate])

  // 进入验证码步即开始重发倒计时；归零后按钮恢复为既有 otp/request 调用。
  useEffect(() => {
    if (step === 'otp') setResendIn(RESEND_COOLDOWN_SECONDS)
  }, [step])
  useEffect(() => {
    if (step !== 'otp' || resendIn <= 0) return
    const timer = setTimeout(() => setResendIn((left) => Math.max(0, left - 1)), 1000)
    return () => clearTimeout(timer)
  }, [step, resendIn])
  const providers = useQuery({
    queryKey: ['auth', 'oauth-providers'],
    queryFn: async ({ signal }) => {
      const res = await api<OAuthProviderInfo[]>(API_ENDPOINTS.auth.oauthProviders, { signal })
      if (!res.success || !Array.isArray(res.data)) throw new ApiError('PROVIDERS_UNAVAILABLE', '暂时无法读取第三方登录方式。请重试或使用邮箱验证码。')
      return res.data
    },
    retry: false,
    staleTime: 60_000,
  })

  function invalidateRequest() {
    requestGate.cancel()
    setLoading(false)
  }

  // Focus lands on the first invalid field after a submit (components.md → Inline
  // error), never while the user is still typing.
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({})
  const focusFirstError = useCallback((next: FieldErrors) => {
    const first = (Object.keys(fieldOfStep) as FieldKey[]).find((key) => Boolean(next[key]))
    if (first) inputRefs.current[first]?.focus()
  }, [])

  const queryClient = useQueryClient()
  useEffect(() => { inputRefs.current[fieldOfStep[step]]?.focus() }, [step])

  /** Typing clears only the field's own error, so a hint never fights another. */
  function clearFieldError(key: FieldKey) {
    setErrors((previous) => {
      if (!previous[key]) return previous
      const next: FieldErrors = { ...previous }
      delete next[key]
      return next
    })
  }

  function reportFailure(message: string) {
    const next: FieldErrors = {}
    next[fieldOfStep[step]] = message
    setErrors(next)
    focusFirstError(next)
  }

  async function handleSendOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedEmail = email.trim()
    const next: FieldErrors = {}
    if (!trimmedEmail) {
      next.email = '邮箱地址不能为空。请填写用于接收登录验证码的邮箱地址。'
    } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
      next.email = '邮箱地址格式不正确。请确认包含 @ 和完整域名，例如 name@example.com。'
    }
    if (step === 'invitation' && !invitationCode.trim()) {
      next.invitation = '邀请码不能为空。请填写收到的邀请码，每个邀请码通常只能使用一次。'
    }

    setErrors(next)
    if (next.email || next.invitation) {
      focusFirstError(next)
      return
    }

    const request = requestGate.begin()
    if (!request) return
    setLoading(true)

    try {
      const res = await api<{ accepted: boolean; nextStep: 'invitation' | 'otp' }>(
        API_ENDPOINTS.auth.otpRequest,
        {
          method: 'POST',
          body: { email: trimmedEmail, invitationCode: invitationCode.trim() || undefined },
          signal: request.signal,
        },
      )
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)

      if (res.success && res.data) {
        setStep(res.data.nextStep)
        return
      }
      reportFailure(res.error?.message || OTP_SEND_FAILED)
    } catch {
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)
      reportFailure(NETWORK_ERROR)
    }
  }

  /** 重发验证码：复用既有 otp/request，后端目前没有冷却状态，前端只做倒计时样式。 */
  async function handleResendOtp() {
    const trimmedEmail = email.trim()
    const request = requestGate.begin()
    if (!request) return
    setLoading(true)

    try {
      const res = await api<{ accepted: boolean; nextStep: 'invitation' | 'otp' }>(
        API_ENDPOINTS.auth.otpRequest,
        {
          method: 'POST',
          body: { email: trimmedEmail, invitationCode: invitationCode.trim() || undefined },
          signal: request.signal,
        },
      )
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)

      if (res.success && res.data) {
        setStep(res.data.nextStep)
        setResendIn(RESEND_COOLDOWN_SECONDS)
        return
      }
      reportFailure(res.error?.message || OTP_SEND_FAILED)
    } catch {
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)
      reportFailure(NETWORK_ERROR)
    }
  }

  async function verifyCode(code: string) {
    if (!code.trim()) {
      const next: FieldErrors = { otp: '验证码不能为空。请输入邮件中收到的 6 位验证码。' }
      setErrors(next)
      focusFirstError(next)
      return
    }

    const request = requestGate.begin()
    if (!request) return
    setLoading(true)

    try {
      const res = await api<{ user: User }>(API_ENDPOINTS.auth.otpVerify, {
        method: 'POST',
        body: {
          email: email.trim(),
          code: code.trim(),
          invitationCode: invitationCode.trim() || undefined,
        },
        signal: request.signal,
      })
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)

      if (res.success && res.data?.user) {
        // Seed the session query so the signed-in user is the single source of
        // truth the moment we navigate away from the login screen.
        queryClient.setQueryData(ACCOUNT_QUERY_KEY, res.data.user)
        router.push(from)
        router.refresh()
        return
      }
      reportFailure(
        res.error?.message || '验证码错误或已过期。请输入邮件中最新的一条验证码，或返回上一步重新发送。',
      )
    } catch {
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)
      reportFailure(NETWORK_ERROR)
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await verifyCode(otpCode)
  }

  /** 六格输满（键入或粘贴）即自动提交；单飞行门保证与按钮提交不重发。 */
  function handleOtpComplete(code: string) {
    void verifyCode(code)
  }

  /** Returns to the email step; the typed values stay in state (失败保留输入). */
  function backToEmail() {
    invalidateRequest()
    setErrors({})
    setStep('email')
  }

  return (
    <div className="flex flex-col">
      <header className="mb-7 flex flex-col gap-2">
        {step === 'otp' ? (
          <button
            type="button"
            onClick={backToEmail}
            className="-ml-1 inline-flex min-h-[var(--control-sm)] items-center gap-1.5 self-start rounded-control px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft weight="bold" aria-hidden="true" className={iconSize.sm} />
            修改邮箱
          </button>
        ) : null}
        <h1 className="text-title tracking-tight text-foreground">
          {step === 'otp' ? '输入验证码' : step === 'invitation' ? '需要邀请码' : '登录 MuseCanvas'}
        </h1>
        <p
          className={`min-w-0 text-[15px] text-muted-foreground [text-wrap:pretty] ${
            step === 'otp' ? '[overflow-wrap:anywhere]' : ''
          }`}
        >
          {step === 'otp' ? (
            <>6 位验证码已发送到 <span className="font-medium text-foreground">{email}</span></>
          ) : step === 'invitation' ? (
            '当前平台处于邀请测试期，请填写有效邀请码。'
          ) : (
            '开始你的创意'
          )}
        </p>
      </header>

      {oauthError && (
        <Alert tone="warning" title="第三方登录未完成" className="mb-4">
          授权可能已取消或暂不可用。请重试已启用的登录方式，或使用邮箱验证码；回调不会自动提交新请求。
        </Alert>
      )}

      {step === 'email' && (
        <form noValidate onSubmit={handleSendOtp} className="flex flex-col gap-4">
          <FieldGroup>
            <FormField id="email" label="邮箱地址" required error={errors.email} hint="邮箱只用于登录与作品找回。">
              <Input
                type="email"
                autoComplete="email"
                size="lg"
                value={email}
                onChange={(event) => {
                  invalidateRequest()
                  setEmail(event.target.value)
                  clearFieldError('email')
                }}
                placeholder="name@example.com"
                className="rounded-control px-4 py-3"
                ref={(node) => {
                  inputRefs.current.email = node
                }}
              />
            </FormField>
          </FieldGroup>

          <Button
            type="submit"
            size="lg"
            loading={loading}
            fullWidth
            className="rounded-control"
          >
            发送验证码
          </Button>
        </form>
      )}

      {step === 'invitation' && (
        <form noValidate onSubmit={handleSendOtp} className="flex flex-col gap-4">
          <FieldGroup>
            <FormField id="invite" label="邀请码" required error={errors.invitation}>
              <Input
                type="text"
                autoComplete="off"
                size="lg"
                value={invitationCode}
                onChange={(event) => {
                  invalidateRequest()
                  setInvitationCode(event.target.value)
                  clearFieldError('invitation')
                }}
                placeholder="请填写邀请码"
                className="rounded-control px-4 py-3"
                ref={(node) => {
                  inputRefs.current.invitation = node
                }}
              />
            </FormField>
          </FieldGroup>

          <div className="flex items-center gap-3">
            <IconButton
              variant="secondary"
              size="lg"
              aria-label="返回上一步，检查邮箱地址"
              onClick={backToEmail}
              icon={<ArrowLeft weight="bold" aria-hidden="true" />}
              className="rounded-control"
            />
            <Button type="submit" size="lg" loading={loading} className="flex-1 rounded-control">
              确认并发送验证码
            </Button>
          </div>
        </form>
      )}

      {step === 'otp' && (
        <form noValidate onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
          {/* The cells sit in their own fieldset with a visible 验证码 legend, so no separate
              FormField label is rendered. The hint and error text follow the cells here. */}
          <div className="flex flex-col">
            <OtpInput
              id="otp"
              value={otpCode}
              onChange={(next) => {
                invalidateRequest()
                setOtpCode(next)
                clearFieldError('otp')
              }}
              onComplete={handleOtpComplete}
              disabled={loading}
              autoFocus
              invalid={Boolean(errors.otp)}
              describedBy={errors.otp ? 'otp-error' : 'otp-hint'}
              firstInputRef={(node) => {
                inputRefs.current.otp = node
              }}
            />
            {errors.otp ? (
              <p id="otp-error" className="mt-1 flex items-start gap-1 text-xs text-danger">
                <CircleAlert weight="fill" aria-hidden="true" className={`mt-0.5 ${iconSize.xs} shrink-0`} />
                <span>{errors.otp}</span>
              </p>
            ) : (
              <p id="otp-hint" className="mt-1 text-xs text-muted-foreground">
                支持直接粘贴整串验证码，输满 6 位自动提交。
              </p>
            )}
          </div>

          <Button type="submit" size="lg" loading={loading} fullWidth className="rounded-control">
            验证并登录
          </Button>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">没收到？检查垃圾邮件</span>
            {/* Cooling down is a disabled button, not a label, so the control keeps its place and state. */}
            <button
              type="button"
              onClick={() => void handleResendOtp()}
              disabled={loading || resendIn > 0}
              className="inline-flex min-h-[var(--control-sm)] items-center rounded-control px-3 font-mono text-xs tabular-nums text-foreground transition-colors hover:bg-tonal disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
            >
              {resendIn > 0 ? `重新发送 · ${formatCountdown(resendIn)}` : '重新发送'}
            </button>
          </div>
        </form>
      )}

      {step === 'email' && (
        <section className="flex flex-col" aria-label="第三方账号登录">
          <Divider label="或使用第三方账号" labelClassName="bg-canvas" className="my-7" />
          {providers.isPending ? <p role="status" className="mb-4 text-center text-xs text-muted-foreground">正在读取可用登录方式…</p> : null}
          {providers.error && <div className="mb-4"><Alert tone="warning" action={<Button variant="secondary" size="sm" loading={providers.isFetching} onClick={() => void providers.refetch()}>重试</Button>}>暂时无法读取第三方登录方式，请重试或使用邮箱验证码。</Alert></div>}
          <div className="grid grid-cols-2 gap-2.5">
            {OAUTH_SLOTS.map(({ provider, label, Icon }) => {
              const info = providers.data?.find((entry) => entry.provider === provider)
              const enabled = info?.enabled === true
              const className = cn(
                buttonVariants({ variant: 'secondary', size: 'md' }),
                'h-11 min-w-0 gap-2.5 disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)]',
              )
              const content = (
                <>
                  <Icon className={`${iconSize.md} shrink-0`} aria-hidden="true" />
                  <span>{info?.label ?? label}</span>
                </>
              )
              return enabled ? (
                <a key={provider} href={API_ENDPOINTS.auth.oauthStart(provider)} className={className}>
                  {content}
                </a>
              ) : (
                <button key={provider} type="button" disabled className={className}>
                  {content}
                </button>
              )
            })}
          </div>
          {providers.data && !providers.data.some(provider => provider.enabled) && <p className="mt-4 text-center text-xs text-muted-foreground">当前没有启用第三方登录，请使用邮箱验证码。</p>}
        </section>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground [text-wrap:pretty]">
        登录即代表你已阅读并同意
        <Link href="/terms" className="rounded-control text-foreground">
          用户协议
        </Link>
        与
        <Link href="/privacy" className="rounded-control text-foreground">
          隐私政策
        </Link>
        。
      </p>
    </div>
  )
}
